"""Durable sitemap configuration and refresh orchestration.

This module owns configuration and run metadata; page fetching remains in
``CrawlRunner`` so the existing ingestion and query APIs keep their behavior.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Callable
from uuid import uuid4

from .crawl import CrawlConfig, CrawlResult, CrawlRunner, ManifestStore
from .sitemap import validate_sitemap_url


INTERVAL_DAYS = {"daily": 1, "weekly": 7, "15-days": 15, "30-days": 30}
THRESHOLDS = (1, 2, 3, 7, 15, 30)
ACTIONS = ("quarantine", "archive", "review")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _next_run(attempted: str, interval: str) -> str:
    return (datetime.fromisoformat(attempted) + timedelta(days=INTERVAL_DAYS[interval])).isoformat()


@dataclass(frozen=True)
class SitemapConfig:
    sitemap_id: str
    owner_id: str
    root_url: str
    interval: str
    threshold: int
    action: str
    active: bool
    created_at: str
    last_attempted: str | None
    last_successful: str | None
    next_scheduled: str | None
    status: str
    failure_reason: str | None


@dataclass(frozen=True)
class RefreshRun:
    run_id: str
    sitemap_id: str
    started_at: str
    completed_at: str | None
    status: str
    discovered_count: int
    unique_count: int
    duplicate_count: int
    error_count: int
    pages_processed: int
    pages_total: int
    errors: tuple[str, ...] = ()
    first_fetched_url: str | None = None
    last_fetched_url: str | None = None


class SitemapManager:
    def __init__(
        self,
        database_path: str | Path,
        runner_factory: Callable[[SitemapConfig], CrawlRunner],
        *,
        clock: Callable[[], str] = _now,
    ) -> None:
        self.database_path = str(database_path)
        self.runner_factory = runner_factory
        self.clock = clock
        self._lock = Lock()
        self._running: set[str] = set()
        Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.database_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sitemap_configs (
                sitemap_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                root_url TEXT NOT NULL,
                interval TEXT NOT NULL,
                threshold INTEGER NOT NULL,
                action TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_attempted TEXT,
                last_successful TEXT,
                next_scheduled TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                failure_reason TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS sitemap_owner_root
                ON sitemap_configs(owner_id, root_url);
            CREATE TABLE IF NOT EXISTS sitemap_refresh_runs (
                run_id TEXT PRIMARY KEY,
                sitemap_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                status TEXT NOT NULL,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                unique_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                pages_processed INTEGER NOT NULL DEFAULT 0,
                pages_total INTEGER NOT NULL DEFAULT 0,
                errors_json TEXT NOT NULL DEFAULT '[]',
                first_fetched_url TEXT,
                last_fetched_url TEXT
            );
            CREATE TABLE IF NOT EXISTS sitemap_membership (
                sitemap_id TEXT NOT NULL,
                url TEXT NOT NULL,
                first_discovered_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                present INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (sitemap_id, url)
            );
            CREATE TABLE IF NOT EXISTS sitemap_refresh_urls (
                run_id TEXT NOT NULL,
                url TEXT NOT NULL,
                sitemap_id TEXT NOT NULL,
                fetch_status TEXT NOT NULL,
                http_status INTEGER,
                error_summary TEXT,
                sitemap_member INTEGER NOT NULL,
                lifecycle_status TEXT,
                fetched_at TEXT,
                PRIMARY KEY (run_id, url)
            );
            CREATE INDEX IF NOT EXISTS refresh_urls_run_index
                ON sitemap_refresh_urls(run_id, url);
            """
        )
        run_columns = {
            row["name"] for row in self._connection.execute(
                "PRAGMA table_info(sitemap_refresh_runs)"
            ).fetchall()
        }
        for name in ("first_fetched_url", "last_fetched_url"):
            if name not in run_columns:
                self._connection.execute(
                    f"ALTER TABLE sitemap_refresh_runs ADD COLUMN {name} TEXT"
                )
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()

    def add(
        self,
        owner_id: str,
        root_url: str,
        interval: str = "daily",
        threshold: int = 3,
        action: str = "review",
    ) -> SitemapConfig:
        if not owner_id.strip():
            raise ValueError("owner_id is required")
        if interval not in INTERVAL_DAYS:
            raise ValueError("interval must be daily, weekly, 15-days, or 30-days")
        if threshold not in THRESHOLDS:
            raise ValueError("threshold must be one of 1, 2, 3, 7, 15, or 30")
        if action not in ACTIONS:
            raise ValueError("action must be quarantine, archive, or review")
        normalized = validate_sitemap_url(root_url)
        now = self.clock()
        record = SitemapConfig(
            f"sm_{uuid4().hex}", owner_id.strip(), normalized, interval, threshold,
            action, True, now, None, None, now, "idle", None,
        )
        with self._lock:
            try:
                self._connection.execute(
                    """
                    INSERT INTO sitemap_configs
                    (sitemap_id, owner_id, root_url, interval, threshold, action, active,
                     created_at, next_scheduled, status)
                    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'idle')
                    """,
                    (record.sitemap_id, record.owner_id, record.root_url, record.interval,
                     record.threshold, record.action, record.created_at, record.next_scheduled),
                )
                self._connection.commit()
            except sqlite3.IntegrityError as exc:
                raise ValueError("this sitemap is already configured for the owner") from exc
        return record

    def list(self, owner_id: str) -> tuple[SitemapConfig, ...]:
        rows = self._connection.execute(
            "SELECT * FROM sitemap_configs WHERE owner_id = ? AND active = 1 ORDER BY created_at",
            (owner_id,),
        ).fetchall()
        return tuple(self._config(row) for row in rows)

    def get(self, owner_id: str, sitemap_id: str) -> SitemapConfig | None:
        row = self._connection.execute(
            "SELECT * FROM sitemap_configs WHERE sitemap_id = ? AND owner_id = ? AND active = 1",
            (sitemap_id, owner_id),
        ).fetchone()
        return self._config(row) if row else None

    def refresh(self, owner_id: str, sitemap_id: str) -> RefreshRun:
        config = self.get(owner_id, sitemap_id)
        if config is None:
            raise KeyError("sitemap not found")
        with self._lock:
            if sitemap_id in self._running:
                raise RuntimeError("a refresh is already running for this sitemap")
            self._running.add(sitemap_id)
        started = self.clock()
        run_id = f"refresh_{uuid4().hex}"
        self._connection.execute(
            "INSERT INTO sitemap_refresh_runs(run_id, sitemap_id, started_at, status) VALUES (?, ?, ?, 'running')",
            (run_id, sitemap_id, started),
        )
        self._connection.execute(
            "UPDATE sitemap_configs SET status='running', last_attempted=?, failure_reason=NULL WHERE sitemap_id=?",
            (started, sitemap_id),
        )
        self._connection.commit()
        try:
            runner = self.runner_factory(config)
            try:
                result = runner.run(config.root_url)
                self._record_membership(config.sitemap_id, result.discovered_urls, started)
                self._apply_policy(config)
            finally:
                manifest = getattr(runner, "manifest", None)
                close = getattr(manifest, "close", None)
                if callable(close):
                    close()
            listed = sum(item.listed_url_count for item in result.discovery_summary)
            unique = result.discovered_count
            errors = tuple(item.error for item in result.discovery_summary if item.error)
            outcome_by_url = {item.url: item for item in result.outcomes}
            fetched_urls = [
                url for url in result.discovered_urls
                if url in outcome_by_url and outcome_by_url[url].status != "failed"
            ]
            completed = self.clock()
            run = RefreshRun(
                run_id, sitemap_id, started, completed, "completed", listed, unique,
                sum(item.duplicate_count for item in result.discovery_summary),
                len(errors) + sum(1 for item in result.outcomes if item.status == "failed"),
                len(result.outcomes), result.selected_count, errors,
                fetched_urls[0] if fetched_urls else None,
                fetched_urls[-1] if fetched_urls else None,
            )
            self._record_refresh_urls(config, run_id, result, started)
            self._finish(config, run, completed, None)
            return run
        except Exception as exc:
            completed = self.clock()
            run = RefreshRun(run_id, sitemap_id, started, completed, "failed", 0, 0, 0, 1, 0, 0, (str(exc),))
            self._finish(config, run, completed, str(exc))
            raise
        finally:
            with self._lock:
                self._running.discard(sitemap_id)

    def runs(self, owner_id: str, sitemap_id: str, limit: int = 20) -> tuple[RefreshRun, ...]:
        if self.get(owner_id, sitemap_id) is None:
            raise KeyError("sitemap not found")
        rows = self._connection.execute(
            "SELECT r.* FROM sitemap_refresh_runs r JOIN sitemap_configs s ON s.sitemap_id=r.sitemap_id "
            "WHERE r.sitemap_id=? AND s.owner_id=? ORDER BY r.started_at DESC LIMIT ?",
            (sitemap_id, owner_id, limit),
        ).fetchall()
        return tuple(self._run(row) for row in rows)

    def urls(self, owner_id: str, sitemap_id: str, run_id: str | None = None, limit: int = 500, offset: int = 0) -> tuple[dict[str, object], ...]:
        if self.get(owner_id, sitemap_id) is None:
            raise KeyError("sitemap not found")
        if not 1 <= limit <= 2_000 or offset < 0:
            raise ValueError("limit must be between 1 and 2000 and offset cannot be negative")
        selected_run = run_id
        if selected_run is None:
            row = self._connection.execute(
                "SELECT run_id FROM sitemap_refresh_runs WHERE sitemap_id=? ORDER BY started_at DESC LIMIT 1",
                (sitemap_id,),
            ).fetchone()
            selected_run = row["run_id"] if row else None
        if selected_run is None:
            return ()
        rows = self._connection.execute(
            "SELECT * FROM sitemap_refresh_urls WHERE run_id=? AND sitemap_id=? ORDER BY rowid LIMIT ? OFFSET ?",
            (selected_run, sitemap_id, limit, offset),
        ).fetchall()
        return tuple({
            "run_id": row["run_id"], "url": row["url"], "sitemap_id": row["sitemap_id"],
            "fetch_status": row["fetch_status"], "http_status": row["http_status"],
            "error_summary": row["error_summary"], "sitemap_member": bool(row["sitemap_member"]),
            "lifecycle_status": row["lifecycle_status"], "fetched_at": row["fetched_at"],
        } for row in rows)

    def pending(self, owner_id: str, sitemap_id: str) -> tuple[dict[str, object], ...]:
        config = self.get(owner_id, sitemap_id)
        if config is None:
            raise KeyError("sitemap not found")
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """
                SELECT url, status, last_status_code, consecutive_missing_checks,
                       consecutive_failure_checks, lifecycle_status, quarantine_reason
                FROM sources
                WHERE url IN (SELECT url FROM sitemap_membership WHERE sitemap_id = ?)
                  AND (lifecycle_status IN ('pending_missing', 'pending_action', 'quarantined')
                       OR last_status_code IN (301, 404))
                ORDER BY updated_at DESC
                """
            , (sitemap_id,)).fetchall()
        finally:
            connection.close()
        return tuple({
            "url": row["url"],
            "status": row["status"],
            "http_status": row["last_status_code"],
            "count": max(row["consecutive_missing_checks"], row["consecutive_failure_checks"]),
            "threshold": config.threshold,
            "pending_action": config.action,
            "lifecycle_status": row["lifecycle_status"],
            "reason": row["quarantine_reason"] or "approaching configured threshold",
        } for row in rows if max(row["consecutive_missing_checks"], row["consecutive_failure_checks"]) <= config.threshold)

    def _record_membership(self, sitemap_id: str, urls: tuple[str, ...], seen_at: str) -> None:
        self._connection.execute(
            "UPDATE sitemap_membership SET present=0 WHERE sitemap_id=?",
            (sitemap_id,),
        )
        self._connection.executemany(
            """
            INSERT INTO sitemap_membership(sitemap_id, url, first_discovered_at, last_seen_at, present)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(sitemap_id, url) DO UPDATE SET last_seen_at=excluded.last_seen_at, present=1
            """,
            [(sitemap_id, url, seen_at, seen_at) for url in urls],
        )

    def _record_refresh_urls(self, config: SitemapConfig, run_id: str, result: CrawlResult, fetched_at: str) -> None:
        outcome_by_url = {item.url: item for item in result.outcomes}
        self._connection.executemany(
            """
            INSERT OR REPLACE INTO sitemap_refresh_urls
            (run_id, url, sitemap_id, fetch_status, http_status, error_summary,
             sitemap_member, lifecycle_status, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, 1,
                    (SELECT lifecycle_status FROM sources WHERE url=?), ?)
            """,
            [
                (
                    run_id, url, config.sitemap_id,
                    "failed" if outcome_by_url.get(url, None) and outcome_by_url[url].status == "failed" else
                    (outcome_by_url[url].status if url in outcome_by_url else "not_processed"),
                    outcome_by_url[url].http_status if url in outcome_by_url else None,
                    outcome_by_url[url].error_summary if url in outcome_by_url else None,
                    url, fetched_at if url in outcome_by_url else None,
                )
                for url in result.discovered_urls
            ],
        )
        self._connection.commit()

    def _apply_policy(self, config: SitemapConfig) -> None:
        terminal_status = "pending_action" if config.action == "review" else (
            "quarantined" if config.action == "quarantine" else "archived"
        )
        self._connection.execute(
            """
            UPDATE sources
            SET lifecycle_status = ?, active = CASE WHEN ? IN ('quarantined', 'archived') THEN 0 ELSE active END,
                quarantine_reason = CASE WHEN ? IN ('quarantined', 'archived')
                    THEN 'configured sitemap lifecycle threshold reached' ELSE quarantine_reason END,
                quarantined_at = CASE WHEN ? IN ('quarantined', 'archived') THEN ? ELSE quarantined_at END
            WHERE (consecutive_missing_checks >= ? OR consecutive_failure_checks >= ?)
              AND lifecycle_status NOT IN ('quarantined', 'archived')
              AND url IN (SELECT url FROM sitemap_membership WHERE sitemap_id = ?)
            """,
            (
                terminal_status, terminal_status, terminal_status, terminal_status, self.clock(),
                config.threshold, config.threshold, config.sitemap_id,
            ),
        )

    def due(self) -> tuple[SitemapConfig, ...]:
        now = datetime.fromisoformat(self.clock())
        rows = self._connection.execute(
            "SELECT * FROM sitemap_configs WHERE active=1 AND next_scheduled <= ? AND status != 'running'",
            (now.isoformat(),),
        ).fetchall()
        return tuple(self._config(row) for row in rows)

    def _finish(self, config: SitemapConfig, run: RefreshRun, completed: str, error: str | None) -> None:
        self._connection.execute(
            "UPDATE sitemap_refresh_runs SET completed_at=?, status=?, discovered_count=?, unique_count=?, "
            "duplicate_count=?, error_count=?, pages_processed=?, pages_total=?, errors_json=?, "
            "first_fetched_url=?, last_fetched_url=? WHERE run_id=?",
            (run.completed_at, run.status, run.discovered_count, run.unique_count, run.duplicate_count,
             run.error_count, run.pages_processed, run.pages_total, json.dumps(run.errors),
             run.first_fetched_url, run.last_fetched_url, run.run_id),
        )
        self._connection.execute(
            "UPDATE sitemap_configs SET status=?, last_successful=?, next_scheduled=?, failure_reason=? WHERE sitemap_id=?",
            (run.status, completed if error is None else None, _next_run(completed, config.interval), error, config.sitemap_id),
        )
        self._connection.commit()

    @staticmethod
    def _config(row: sqlite3.Row) -> SitemapConfig:
        return SitemapConfig(
            row["sitemap_id"], row["owner_id"], row["root_url"], row["interval"],
            row["threshold"], row["action"], bool(row["active"]), row["created_at"],
            row["last_attempted"], row["last_successful"], row["next_scheduled"],
            row["status"], row["failure_reason"],
        )

    @staticmethod
    def _run(row: sqlite3.Row) -> RefreshRun:
        return RefreshRun(
            row["run_id"], row["sitemap_id"], row["started_at"], row["completed_at"],
            row["status"], row["discovered_count"], row["unique_count"], row["duplicate_count"],
            row["error_count"], row["pages_processed"], row["pages_total"],
            tuple(json.loads(row["errors_json"])),
            row["first_fetched_url"],
            row["last_fetched_url"],
        )


class RefreshScheduler:
    """Small dependency-free scheduler suitable for the existing local service."""

    def __init__(self, manager: SitemapManager, poll_seconds: float = 30.0) -> None:
        if poll_seconds <= 0:
            raise ValueError("poll_seconds must be positive")
        self.manager = manager
        self.poll_seconds = poll_seconds
        self._stop = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._loop, name="sitemap-refresh-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=max(1.0, self.poll_seconds + 1))

    def _loop(self) -> None:
        while not self._stop.wait(self.poll_seconds):
            for config in self.manager.due():
                try:
                    self.manager.refresh(config.owner_id, config.sitemap_id)
                except Exception:
                    continue
