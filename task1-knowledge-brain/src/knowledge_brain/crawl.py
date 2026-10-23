"""Bounded, resumable sitemap crawl runner for Task 1."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Callable, Iterable, Protocol
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit
from urllib import robotparser

from .sitemap import SITEMAP_URL, SitemapEntry, SitemapParseError, parse_sitemap, validate_sitemap_url


class Fetcher(Protocol):
    def __call__(self, url: str, timeout_seconds: float) -> "FetchResponse": ...


@dataclass(frozen=True)
class FetchResponse:
    status_code: int
    content: bytes
    last_modified: str | None = None


class FetchFailure(RuntimeError):
    def __init__(self, message: str, attempts: int, transient: bool, status_code: int | None = None) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.transient = transient
        self.status_code = status_code


@dataclass(frozen=True)
class CrawlConfig:
    max_articles: int = 10
    timeout_seconds: float = 15.0
    max_concurrency: int = 2
    request_delay_seconds: float = 0.0
    max_retries: int = 2
    backoff_seconds: float = 0.5
    user_agent: str = "BusinessLabsKnowledgeBrain/0.1"
    max_sitemap_depth: int = 8
    max_sitemap_documents: int = 1_000

    def __post_init__(self) -> None:
        if self.max_articles < 1:
            raise ValueError("max_articles must be positive")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self.max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        if self.request_delay_seconds < 0 or self.backoff_seconds < 0:
            raise ValueError("delays cannot be negative")
        if self.max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        if self.max_sitemap_depth < 0:
            raise ValueError("max_sitemap_depth cannot be negative")
        if self.max_sitemap_documents < 1:
            raise ValueError("max_sitemap_documents must be positive")


@dataclass(frozen=True)
class PageOutcome:
    url: str
    status: str
    attempts: int
    error_summary: str | None = None
    http_status: int | None = None


@dataclass(frozen=True)
class CrawlResult:
    discovered_count: int
    selected_count: int
    outcomes: tuple[PageOutcome, ...]
    removed_count: int
    discovery_complete: bool
    discovery_summary: tuple["SitemapSummary", ...] = ()
    discovered_urls: tuple[str, ...] = ()


@dataclass(frozen=True)
class SitemapSummary:
    sitemap_url: str
    depth: int
    child_sitemaps: tuple[str, ...]
    listed_url_count: int
    first_url: str | None
    last_url: str | None
    skipped_count: int = 0
    error: str | None = None
    duplicate_count: int = 0


class ManifestStore:
    """SQLite manifest and content-version store owned by the crawler."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = str(database_path)
        Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sources (
                url TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_modified TEXT,
                content_hash TEXT,
                last_successful_ingestion TEXT,
                error_summary TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS article_versions (
                url TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                content BLOB NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (url, content_hash)
            );
            """
        )
        self._ensure_health_columns()
        self.connection.commit()

    def _ensure_health_columns(self) -> None:
        existing = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(sources)").fetchall()
        }
        columns = {
            "first_discovered_at": "TEXT",
            "last_seen_at": "TEXT",
            "last_status_code": "INTEGER",
            "consecutive_missing_checks": "INTEGER NOT NULL DEFAULT 0",
            "consecutive_failure_checks": "INTEGER NOT NULL DEFAULT 0",
            "lifecycle_status": "TEXT NOT NULL DEFAULT 'active'",
            "quarantine_reason": "TEXT",
            "quarantined_at": "TEXT",
        }
        for name, definition in columns.items():
            if name not in existing:
                self.connection.execute(f"ALTER TABLE sources ADD COLUMN {name} {definition}")

    def close(self) -> None:
        self.connection.close()

    def mark_started(self, url: str) -> None:
        now = _now()
        self.connection.execute(
            """
            INSERT INTO sources(url, status, active, updated_at)
            VALUES (?, 'in_progress', 1, ?)
            ON CONFLICT(url) DO UPDATE SET
                status = 'in_progress', active = 1, error_summary = NULL,
                updated_at = excluded.updated_at
            """,
            (url, now),
        )
        self.connection.execute(
            """
            UPDATE sources
            SET first_discovered_at = COALESCE(first_discovered_at, ?),
                last_seen_at = ?, consecutive_missing_checks = 0,
                lifecycle_status = CASE WHEN lifecycle_status = 'quarantined' THEN lifecycle_status ELSE 'active' END
            WHERE url = ?
            """,
            (_now(), _now(), url),
        )
        self.connection.commit()

    def record_success(
        self,
        url: str,
        response: FetchResponse,
        attempts: int,
    ) -> str:
        content_hash = hashlib.sha256(response.content).hexdigest()
        previous = self.connection.execute(
            "SELECT content_hash FROM sources WHERE url = ?", (url,)
        ).fetchone()
        status = "unchanged" if previous and previous["content_hash"] == content_hash else (
            "changed" if previous and previous["content_hash"] else "new"
        )
        now = _now()
        self.connection.execute(
            """
            INSERT INTO article_versions(url, content_hash, content, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(url, content_hash) DO NOTHING
            """,
            (url, content_hash, response.content, now),
        )
        self.connection.execute(
            """
            INSERT INTO sources(
                url, status, attempt_count, last_modified, content_hash,
                last_successful_ingestion, error_summary, active, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)
            ON CONFLICT(url) DO UPDATE SET
                status = excluded.status,
                attempt_count = sources.attempt_count + excluded.attempt_count,
                last_modified = excluded.last_modified,
                content_hash = excluded.content_hash,
                last_successful_ingestion = excluded.last_successful_ingestion,
                error_summary = NULL,
                active = 1,
                updated_at = excluded.updated_at
            """,
            (url, status, attempts, response.last_modified, content_hash, now, now),
        )
        self.connection.execute(
            """
            UPDATE sources
            SET first_discovered_at = COALESCE(first_discovered_at, ?),
                last_seen_at = ?, last_status_code = ?,
                consecutive_missing_checks = 0, consecutive_failure_checks = 0,
            lifecycle_status = 'active',
                quarantine_reason = NULL, quarantined_at = NULL
            WHERE url = ?
            """,
            (now, now, response.status_code, url),
        )
        self.connection.commit()
        return status

    def record_failure(
        self,
        url: str,
        attempts: int,
        error_summary: str,
        status_code: int | None = None,
    ) -> None:
        now = _now()
        self.connection.execute(
            """
            INSERT INTO sources(
                url, status, attempt_count, error_summary, active, updated_at
            ) VALUES (?, 'failed', ?, ?, 1, ?)
            ON CONFLICT(url) DO UPDATE SET
                status = 'failed',
                attempt_count = sources.attempt_count + excluded.attempt_count,
                error_summary = excluded.error_summary,
                updated_at = excluded.updated_at
            """,
            (url, attempts, error_summary[:500], now),
        )
        self.connection.execute(
            """
            UPDATE sources
            SET first_discovered_at = COALESCE(first_discovered_at, ?),
                last_status_code = COALESCE(?, last_status_code),
                consecutive_failure_checks = consecutive_failure_checks + 1
            WHERE url = ?
            """,
            (now, status_code, url),
        )
        self.connection.commit()

    def mark_removed(self, discovered_urls: set[str]) -> int:
        rows = self.connection.execute(
            "SELECT url FROM sources WHERE active = 1"
        ).fetchall()
        removed = [row["url"] for row in rows if row["url"] not in discovered_urls]
        now = _now()
        self.connection.executemany(
            """
            UPDATE sources SET status = 'removed', active = 0,
                error_summary = 'not present in sitemap', updated_at = ?
            WHERE url = ?
            """,
            [(now, url) for url in removed],
        )
        self.connection.executemany(
            """
            UPDATE sources
            SET last_seen_at = ?, consecutive_missing_checks = consecutive_missing_checks + 1,
                lifecycle_status = CASE WHEN lifecycle_status = 'active' THEN 'pending_missing' ELSE lifecycle_status END
            WHERE url = ?
            """,
            [(now, url) for url in removed],
        )
        self.connection.commit()
        return len(removed)

    def source(self, url: str) -> sqlite3.Row | None:
        return self.connection.execute(
            "SELECT * FROM sources WHERE url = ?", (url,)
        ).fetchone()

    def version_count(self, url: str) -> int:
        row = self.connection.execute(
            "SELECT COUNT(*) AS count FROM article_versions WHERE url = ?", (url,)
        ).fetchone()
        return int(row["count"])


class RobotsTxtPolicy:
    """Fail-closed robots policy with one cached policy per host."""

    def __init__(self, fetcher: Fetcher, user_agent: str, timeout_seconds: float) -> None:
        self.fetcher = fetcher
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds
        self._policies: dict[str, robotparser.RobotFileParser | None] = {}
        self._lock = threading.Lock()

    def __call__(self, url: str) -> bool:
        host = urlsplit(url).netloc.lower()
        with self._lock:
            if host not in self._policies:
                robots_url = f"https://{host}/robots.txt"
                try:
                    response = self.fetcher(robots_url, self.timeout_seconds)
                except Exception:
                    self._policies[host] = None
                else:
                    if response.status_code == 404:
                        self._policies[host] = robotparser.RobotFileParser()
                        self._policies[host].parse([])
                    elif 200 <= response.status_code < 300:
                        parser = robotparser.RobotFileParser()
                        parser.parse(response.content.decode("utf-8", "replace").splitlines())
                        self._policies[host] = parser
                    else:
                        self._policies[host] = None
            policy = self._policies[host]
        return policy is not None and policy.can_fetch(self.user_agent, url)


class _RateLimiter:
    def __init__(self, delay_seconds: float, sleep: Callable[[float], None]) -> None:
        self.delay_seconds = delay_seconds
        self.sleep = sleep
        self.next_request = 0.0
        self.lock = threading.Lock()

    def wait(self) -> None:
        if self.delay_seconds == 0:
            return
        with self.lock:
            now = time.monotonic()
            wait_for = max(0.0, self.next_request - now)
            self.next_request = max(now, self.next_request) + self.delay_seconds
        if wait_for:
            self.sleep(wait_for)


def urllib_fetcher(user_agent: str) -> Fetcher:
    class NoRedirect(urllib_request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib_request.build_opener(NoRedirect)

    def fetch(url: str, timeout_seconds: float) -> FetchResponse:
        request = urllib_request.Request(url, headers={"User-Agent": user_agent})
        try:
            with opener.open(request, timeout=timeout_seconds) as response:
                return FetchResponse(
                    response.status,
                    response.read(),
                    response.headers.get("Last-Modified"),
                )
        except urllib_error.HTTPError as exc:
            transient = exc.code in {408, 429} or 500 <= exc.code < 600
            raise FetchFailure(
                f"HTTP {exc.code} for {url}", 1, transient, exc.code
            ) from exc
        except (TimeoutError, urllib_error.URLError) as exc:
            raise FetchFailure(f"network failure for {url}: {exc}", 1, True) from exc

    return fetch


class CrawlRunner:
    def __init__(
        self,
        manifest: ManifestStore,
        fetcher: Fetcher | None = None,
        robots_checker: Callable[[str], bool] | None = None,
        config: CrawlConfig | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config or CrawlConfig()
        self.fetcher = fetcher or urllib_fetcher(self.config.user_agent)
        self.robots_checker = robots_checker or RobotsTxtPolicy(
            self.fetcher, self.config.user_agent, self.config.timeout_seconds
        )
        self.manifest = manifest
        self.sleep = sleep
        self.rate_limiter = _RateLimiter(self.config.request_delay_seconds, sleep)
        self.last_discovery_summary: tuple[SitemapSummary, ...] = ()

    def run(self, sitemap_url: str | Iterable[str] = SITEMAP_URL) -> CrawlResult:
        roots = [sitemap_url] if isinstance(sitemap_url, str) else list(sitemap_url)
        if not roots or any(not isinstance(root, str) or not root.strip() for root in roots):
            raise ValueError("at least one sitemap URL is required")
        sitemap_entries: list[SitemapEntry] = []
        discovery_complete = True
        summaries: list[SitemapSummary] = []
        for root in roots:
            discovered, complete, root_summaries = self._discover(root)
            sitemap_entries.extend(discovered)
            discovery_complete = discovery_complete and complete
            summaries.extend(root_summaries)
        self.last_discovery_summary = tuple(summaries)
        deduplicated: dict[str, SitemapEntry] = {}
        for entry in sitemap_entries:
            deduplicated.setdefault(entry.url, entry)
        sitemap_entries = list(deduplicated.values())
        by_url = {entry.url: entry for entry in sitemap_entries}
        discovered_urls = set(by_url)
        selected = list(by_url.values())[: self.config.max_articles]
        for entry in selected:
            self.manifest.mark_started(entry.url)

        outcomes: list[PageOutcome] = []
        with ThreadPoolExecutor(max_workers=self.config.max_concurrency) as executor:
            futures = {executor.submit(self._fetch_page, entry): entry for entry in selected}
            for future in as_completed(futures):
                entry = futures[future]
                try:
                    response, attempts = future.result()
                except FetchFailure as exc:
                    self.manifest.record_failure(entry.url, exc.attempts, str(exc), exc.status_code)
                    outcomes.append(PageOutcome(entry.url, "failed", exc.attempts, str(exc), exc.status_code))
                except Exception as exc:
                    self.manifest.record_failure(entry.url, 1, str(exc))
                    outcomes.append(PageOutcome(entry.url, "failed", 1, str(exc)))
                else:
                    status = self.manifest.record_success(entry.url, response, attempts)
                    outcomes.append(PageOutcome(entry.url, status, attempts, None, response.status_code))

        removed_count = self.manifest.mark_removed(discovered_urls) if discovery_complete else 0
        outcomes.sort(key=lambda outcome: outcome.url)
        return CrawlResult(
            discovered_count=len(discovered_urls),
            selected_count=len(selected),
            outcomes=tuple(outcomes),
            removed_count=removed_count,
            discovery_complete=discovery_complete,
            discovery_summary=tuple(summaries),
            discovered_urls=tuple(discovered_urls),
        )

    def _discover(self, sitemap_url: str) -> tuple[list[SitemapEntry], bool, list[SitemapSummary]]:
        entries: list[SitemapEntry] = []
        complete = True
        summaries: list[SitemapSummary] = []
        visited: set[str] = set()
        root_parts = urlsplit(sitemap_url)
        allowed_hosts = {root_parts.hostname} if root_parts.hostname else None
        try:
            normalized_root = validate_sitemap_url(
                sitemap_url,
                allowed_hosts=allowed_hosts,
                allow_http=root_parts.scheme.lower() == "http",
            )
        except ValueError as exc:
            return [], False, [SitemapSummary(sitemap_url, 0, (), 0, None, None, error=str(exc))]
        stack: list[tuple[str, int]] = [(normalized_root, 0)]
        documents = 0
        while stack:
            current_url, depth = stack.pop()
            if current_url in visited:
                complete = False
                summaries.append(SitemapSummary(current_url, depth, (), 0, None, None, error="circular_reference"))
                continue
            if depth > self.config.max_sitemap_depth or documents >= self.config.max_sitemap_documents:
                complete = False
                summaries.append(SitemapSummary(current_url, depth, (), 0, None, None, error="sitemap_limit_exceeded"))
                continue
            visited.add(current_url)
            documents += 1
            try:
                response, _ = self._fetch_with_retry(current_url)
                parsed = parse_sitemap(
                    response.content,
                    allowed_hosts=allowed_hosts,
                    allow_http=root_parts.scheme.lower() == "http",
                )
            except (FetchFailure, SitemapParseError) as exc:
                complete = False
                summaries.append(SitemapSummary(current_url, depth, (), 0, None, None, error=str(exc)))
                continue
            if parsed.kind == "urlset":
                entries.extend(parsed.entries)
                urls = tuple(entry.url for entry in parsed.entries)
                summaries.append(SitemapSummary(
                    current_url, depth, (), len(urls), urls[0] if urls else None,
                    urls[-1] if urls else None, len(parsed.skipped),
                    duplicate_count=sum(1 for item in parsed.skipped if item.reason == "duplicate_url"),
                ))
                continue
            children = tuple(child.url for child in parsed.child_sitemaps)
            summaries.append(SitemapSummary(
                current_url, depth, children, 0, None, None, len(parsed.skipped),
                duplicate_count=sum(1 for item in parsed.skipped if item.reason == "duplicate_url"),
            ))
            for child in reversed(parsed.child_sitemaps):
                stack.append((child.url, depth + 1))
        deduplicated: dict[str, SitemapEntry] = {}
        for entry in entries:
            deduplicated.setdefault(entry.url, entry)
        return list(deduplicated.values()), complete, summaries

    def _fetch_page(self, entry: SitemapEntry) -> tuple[FetchResponse, int]:
        response, attempts = self._fetch_with_retry(entry.url)
        if response.last_modified is None and entry.last_modified is not None:
            response = FetchResponse(response.status_code, response.content, entry.last_modified)
        return response, attempts

    def _fetch_with_retry(self, url: str) -> tuple[FetchResponse, int]:
        if not self.robots_checker(url):
            raise FetchFailure(f"robots/access policy denied {url}", 0, False)
        attempts = 0
        last_error = "request failed"
        while attempts <= self.config.max_retries:
            attempts += 1
            self.rate_limiter.wait()
            try:
                response = self.fetcher(url, self.config.timeout_seconds)
                if 200 <= response.status_code < 300:
                    return response, attempts
                transient = response.status_code in {408, 429} or 500 <= response.status_code < 600
                last_error = f"HTTP {response.status_code} for {url}"
                if not transient:
                    raise FetchFailure(last_error, attempts, False, response.status_code)
            except FetchFailure as exc:
                attempts = max(attempts, exc.attempts)
                last_error = str(exc)
                if not exc.transient:
                    raise FetchFailure(last_error, attempts, False) from exc
            except Exception as exc:
                last_error = f"request failure for {url}: {exc}"
            if attempts <= self.config.max_retries:
                self.sleep(self.config.backoff_seconds * (2 ** (attempts - 1)))
        raise FetchFailure(last_error, attempts, True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
