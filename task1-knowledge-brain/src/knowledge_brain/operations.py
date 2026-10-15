"""Operational wrapper for safe daily Task 1 ingestion."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Callable
from uuid import uuid4

from .crawl import CrawlResult, CrawlRunner


@dataclass(frozen=True)
class OperationalReport:
    run_id: str
    state: str
    added: int
    updated: int
    unchanged: int
    removed: int
    failed: int
    error: str | None = None


class DailyIngestionJob:
    _process_lock = Lock()

    def __init__(self, runner_factory: Callable[[], CrawlRunner], lock_path: str | Path | None = None) -> None:
        self.runner_factory = runner_factory
        self.lock_path = Path(lock_path) if lock_path else None

    def run(self) -> OperationalReport:
        if not self._process_lock.acquire(blocking=False):
            return OperationalReport("", "already_running", 0, 0, 0, 0, 0, "another ingestion run is active")
        try:
            if self.lock_path and self.lock_path.exists():
                return OperationalReport("", "already_running", 0, 0, 0, 0, 0, "lock file exists")
            if self.lock_path:
                self.lock_path.parent.mkdir(parents=True, exist_ok=True)
                self.lock_path.write_text("active", encoding="utf-8")
            run_id = f"run_{uuid4().hex}"
            try:
                result = self.runner_factory().run()
                return _report(run_id, result)
            finally:
                if self.lock_path:
                    self.lock_path.unlink(missing_ok=True)
        finally:
            self._process_lock.release()


def _report(run_id: str, result: CrawlResult) -> OperationalReport:
    counts = {"new": 0, "changed": 0, "unchanged": 0, "failed": 0}
    for outcome in result.outcomes:
        if outcome.status in counts:
            counts[outcome.status] += 1
    return OperationalReport(run_id, "completed", counts["new"], counts["changed"], counts["unchanged"], result.removed_count, counts["failed"])
