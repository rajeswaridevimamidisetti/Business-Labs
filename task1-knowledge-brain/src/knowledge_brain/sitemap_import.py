"""Sitemap URL extraction and persistence for Step 1.

The local-file API never downloads a sitemap. The live-fetch API downloads only
the trusted source sitemap and same-host child sitemap documents; it never
downloads article pages.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import os
from collections.abc import Callable
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit
from uuid import uuid4

from .sitemap import SitemapEntry, SitemapParseError, SkippedUrl, parse_sitemap, validate_sitemap_url


ARTICLE_PATH = "/support/solutions/articles/"
_ARTICLE_RE = re.compile(r"^/support/solutions/articles/[^/?#]+(?:/.*)?$", re.IGNORECASE)


@dataclass(frozen=True)
class SitemapExtractionReport:
    import_id: str
    source_url: str
    source_path: str | None
    extracted_at: str
    total_sitemap_urls: int
    unique_sitemap_urls: int
    article_urls_identified: int
    unique_article_urls_saved: int
    duplicate_urls_removed: int
    rejected_urls: int
    rejected_by_reason: dict[str, int]
    rejected_values: tuple[dict[str, str], ...]
    all_urls_path: str
    article_urls_path: str
    documents_fetched: int = 1

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class SitemapFetchError(RuntimeError):
    """Raised when a live sitemap cannot be fetched and parsed completely."""


@dataclass(frozen=True)
class FetchedSitemapCollection:
    source_url: str
    entries: tuple[SitemapEntry, ...]
    total_url_entries: int
    duplicate_urls_removed: int
    rejected: tuple[SkippedUrl, ...]
    documents_fetched: int


def _urllib_sitemap_fetcher(user_agent: str) -> Callable[[str, float], bytes]:
    class NoRedirect(urllib_request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib_request.build_opener(NoRedirect)

    def fetch(url: str, timeout_seconds: float) -> bytes:
        request = urllib_request.Request(url, headers={"User-Agent": user_agent})
        try:
            with opener.open(request, timeout=timeout_seconds) as response:
                if not 200 <= response.status < 300:
                    raise SitemapFetchError(f"sitemap fetch returned HTTP {response.status}")
                return response.read()
        except urllib_error.HTTPError as exc:
            raise SitemapFetchError(f"sitemap fetch returned HTTP {exc.code}") from exc
        except (TimeoutError, urllib_error.URLError, OSError) as exc:
            raise SitemapFetchError("sitemap fetch failed due to a network error") from exc

    return fetch


def fetch_sitemap_collection(
    source_url: str,
    *,
    timeout_seconds: float = 20.0,
    max_documents: int = 100,
    max_bytes_per_document: int = 20 * 1024 * 1024,
    user_agent: str = "BusinessLabsKnowledgeBrain/0.1",
    fetcher: Callable[[str, float], bytes] | None = None,
) -> FetchedSitemapCollection:
    """Fetch and parse a trusted sitemap or same-host sitemap index only.

    Child sitemap URLs are validated before they are requested. No article pages
    are fetched by this function.
    """
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if max_documents < 1:
        raise ValueError("max_documents must be positive")
    if max_bytes_per_document < 1:
        raise ValueError("max_bytes_per_document must be positive")
    parsed_source = urlsplit(source_url)
    source_host = parsed_source.hostname
    if source_host is None:
        raise SitemapFetchError("sitemap source has no hostname")
    try:
        normalized_source = validate_sitemap_url(
            source_url,
            allowed_hosts={source_host},
            allow_http=False,
        )
    except ValueError as exc:
        raise SitemapFetchError("sitemap source URL is unsafe or invalid") from exc

    request = fetcher or _urllib_sitemap_fetcher(user_agent)
    pending = [normalized_source]
    visited: set[str] = set()
    all_entries: list[SitemapEntry] = []
    rejected: list[SkippedUrl] = []
    total_url_entries = 0
    duplicate_urls_removed = 0

    while pending:
        current_url = pending.pop()
        if current_url in visited:
            continue
        if len(visited) >= max_documents:
            raise SitemapFetchError("sitemap document limit exceeded")
        visited.add(current_url)
        try:
            content = request(current_url, timeout_seconds)
        except SitemapFetchError:
            raise
        except Exception as exc:
            raise SitemapFetchError("sitemap fetch failed") from exc
        if len(content) > max_bytes_per_document:
            raise SitemapFetchError("sitemap document exceeds the configured size limit")
        try:
            parsed = parse_sitemap(
                content,
                allowed_hosts={source_host},
                allow_http=False,
            )
        except SitemapParseError as exc:
            raise SitemapFetchError("sitemap XML is invalid") from exc
        rejected.extend(item for item in parsed.skipped if item.reason != "duplicate_url")
        duplicate_urls_removed += sum(1 for item in parsed.skipped if item.reason == "duplicate_url")
        if parsed.kind == "urlset":
            total_url_entries += len(parsed.entries) + len(parsed.skipped)
            all_entries.extend(parsed.entries)
            continue
        for child in parsed.child_sitemaps:
            try:
                child_url = validate_sitemap_url(
                    child.url,
                    allowed_hosts={source_host},
                    allow_http=False,
                )
            except ValueError as exc:
                raise SitemapFetchError("sitemap index contains an unsafe child URL") from exc
            if child_url not in visited and child_url not in pending:
                pending.append(child_url)

    deduplicated: dict[str, SitemapEntry] = {}
    for entry in all_entries:
        if entry.url in deduplicated:
            duplicate_urls_removed += 1
        else:
            deduplicated[entry.url] = entry
    return FetchedSitemapCollection(
        source_url=normalized_source,
        entries=tuple(deduplicated.values()),
        total_url_entries=total_url_entries,
        duplicate_urls_removed=duplicate_urls_removed,
        rejected=tuple(rejected),
        documents_fetched=len(visited),
    )


def is_article_url(url: str) -> bool:
    """Return whether a normalized source URL matches the article path."""
    parsed = urlsplit(url)
    return parsed.hostname == "support.brilliantdirectories.com" and bool(
        _ARTICLE_RE.fullmatch(parsed.path)
    )


def extract_sitemap_xml(
    xml: str | bytes,
    *,
    source_url: str,
    database_path: str | Path,
    source_path: str | Path | None = None,
    all_urls_path: str | Path | None = None,
    article_urls_path: str | Path | None = None,
    now: str | None = None,
) -> SitemapExtractionReport:
    """Parse one local urlset, persist all accepted URLs, and return counts."""
    extracted_at = now or datetime.now(timezone.utc).isoformat()
    try:
        parsed = parse_sitemap(xml, allowed_hosts={"support.brilliantdirectories.com"})
    except SitemapParseError:
        raise
    if parsed.kind != "urlset":
        raise SitemapParseError("Step 1 requires a urlset file, not a sitemap index")

    total = len(parsed.entries) + len(parsed.skipped)
    duplicates = sum(1 for item in parsed.skipped if item.reason == "duplicate_url")
    rejected = [item for item in parsed.skipped if item.reason != "duplicate_url"]
    return _persist_sitemap_data(
        entries=tuple(parsed.entries),
        source_url=source_url,
        source_path=source_path,
        database_path=database_path,
        extracted_at=extracted_at,
        total_sitemap_urls=total,
        duplicate_urls_removed=duplicates,
        rejected=tuple(rejected),
        all_urls_path=all_urls_path,
        article_urls_path=article_urls_path,
    )


def persist_fetched_sitemap(
    collection: FetchedSitemapCollection,
    *,
    database_path: str | Path,
    all_urls_path: str | Path | None = None,
    article_urls_path: str | Path | None = None,
    report_path: str | Path | None = None,
    now: str | None = None,
) -> SitemapExtractionReport:
    """Persist a completely fetched sitemap collection and its verification report."""
    report = _persist_sitemap_data(
        entries=collection.entries,
        source_url=collection.source_url,
        source_path=None,
        database_path=database_path,
        extracted_at=now or datetime.now(timezone.utc).isoformat(),
        total_sitemap_urls=collection.total_url_entries,
        duplicate_urls_removed=collection.duplicate_urls_removed,
        rejected=collection.rejected,
        all_urls_path=all_urls_path,
        article_urls_path=article_urls_path,
        documents_fetched=collection.documents_fetched,
    )
    if report_path:
        destination = Path(report_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps({**report.to_dict(), "documents_fetched": collection.documents_fetched}, indent=2) + "\n", encoding="utf-8")
    return report


def _persist_sitemap_data(
    *,
    entries: tuple[SitemapEntry, ...],
    source_url: str,
    source_path: str | Path | None,
    database_path: str | Path,
    extracted_at: str,
    total_sitemap_urls: int,
    duplicate_urls_removed: int,
    rejected: tuple[SkippedUrl, ...],
    all_urls_path: str | Path | None,
    article_urls_path: str | Path | None,
    documents_fetched: int = 1,
) -> SitemapExtractionReport:
    import_id = f"sitemap_import_{uuid4().hex}"
    article_urls = tuple(entry.url for entry in entries if is_article_url(entry.url))
    rejected_by_reason: dict[str, int] = {}
    for item in rejected:
        rejected_by_reason[item.reason] = rejected_by_reason.get(item.reason, 0) + 1
    path = str(Path(database_path))
    all_urls_destination = Path(all_urls_path) if all_urls_path else Path(path).parent / "sitemap-urls.txt"
    article_urls_destination = Path(article_urls_path) if article_urls_path else Path(path).parent / "article-urls.txt"
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        with connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sitemap_imports (
                    import_id TEXT PRIMARY KEY,
                    source_url TEXT NOT NULL,
                    source_path TEXT,
                    extracted_at TEXT NOT NULL,
                    total_sitemap_urls INTEGER NOT NULL,
                    unique_sitemap_urls INTEGER NOT NULL,
                    article_urls_identified INTEGER NOT NULL,
                    unique_article_urls_saved INTEGER NOT NULL,
                    duplicate_urls_removed INTEGER NOT NULL,
                    rejected_urls INTEGER NOT NULL,
                    rejected_by_reason_json TEXT NOT NULL,
                    documents_fetched INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS sitemap_source_urls (
                    source_url TEXT NOT NULL,
                    normalized_url TEXT NOT NULL,
                    is_article INTEGER NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    last_import_id TEXT NOT NULL,
                    PRIMARY KEY (source_url, normalized_url)
                );
                CREATE TABLE IF NOT EXISTS sitemap_rejected_urls (
                    import_id TEXT NOT NULL,
                    raw_url TEXT NOT NULL,
                    reason TEXT NOT NULL
                );
                """
            )
            existing_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(sitemap_imports)").fetchall()
            }
            if "documents_fetched" not in existing_columns:
                connection.execute(
                    "ALTER TABLE sitemap_imports ADD COLUMN documents_fetched INTEGER NOT NULL DEFAULT 1"
                )
            connection.executemany(
                """
                INSERT INTO sitemap_source_urls
                    (source_url, normalized_url, is_article, first_seen_at, last_seen_at, last_import_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_url, normalized_url) DO UPDATE SET
                    is_article=excluded.is_article,
                    last_seen_at=excluded.last_seen_at,
                    last_import_id=excluded.last_import_id
                """,
                [
                    (source_url, entry.url, int(is_article_url(entry.url)), extracted_at, extracted_at, import_id)
                    for entry in entries
                ],
            )
            connection.executemany(
                "INSERT INTO sitemap_rejected_urls(import_id, raw_url, reason) VALUES (?, ?, ?)",
                [(import_id, item.value, item.reason) for item in rejected],
            )
            connection.execute(
                """
                INSERT INTO sitemap_imports
                    (import_id, source_url, source_path, extracted_at, total_sitemap_urls,
                     unique_sitemap_urls, article_urls_identified, unique_article_urls_saved,
                     duplicate_urls_removed, rejected_urls, rejected_by_reason_json, documents_fetched)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    import_id, source_url, str(source_path) if source_path else None, extracted_at,
                    total_sitemap_urls, len(entries), len(article_urls), len(article_urls), duplicate_urls_removed,
                    len(rejected), json.dumps(rejected_by_reason, sort_keys=True), documents_fetched,
                ),
            )
    finally:
        connection.close()

    _write_lines_atomically(all_urls_destination, (entry.url for entry in entries))
    _write_lines_atomically(article_urls_destination, article_urls)

    return SitemapExtractionReport(
        import_id=import_id,
        source_url=source_url,
        source_path=str(source_path) if source_path else None,
        extracted_at=extracted_at,
        total_sitemap_urls=total_sitemap_urls,
        unique_sitemap_urls=len(entries),
        article_urls_identified=len(article_urls),
        unique_article_urls_saved=len(article_urls),
        duplicate_urls_removed=duplicate_urls_removed,
        rejected_urls=len(rejected),
        rejected_by_reason=rejected_by_reason,
        rejected_values=tuple({"value": item.value, "reason": item.reason} for item in rejected),
        all_urls_path=str(all_urls_destination),
        article_urls_path=str(article_urls_destination),
        documents_fetched=documents_fetched,
    )


def extract_sitemap_file(
    input_path: str | Path,
    *,
    source_url: str,
    database_path: str | Path,
    report_path: str | Path | None = None,
    all_urls_path: str | Path | None = None,
    article_urls_path: str | Path | None = None,
) -> SitemapExtractionReport:
    """Extract a caller-supplied XML file without any network access."""
    source = Path(input_path)
    report = extract_sitemap_xml(
        source.read_bytes(), source_url=source_url, database_path=database_path, source_path=source,
        all_urls_path=all_urls_path, article_urls_path=article_urls_path,
    )
    if report_path:
        destination = Path(report_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report.to_dict(), indent=2) + "\n", encoding="utf-8")
    return report


def _write_lines_atomically(destination: Path, lines: object) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8", newline="\n")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
