"""Local-only Task 1 API server entry point."""

import os
from pathlib import Path
from threading import Lock
from wsgiref.simple_server import make_server

from .api import IngestionService, IngestionStatus, Task1Api, create_wsgi_app
from .crawl import CrawlConfig, CrawlRunner, ManifestStore
from .operations import DailyIngestionJob
from .sitemap import SITEMAP_URL


class LocalIngestionService(IngestionService):
    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        self.sitemap_url = os.getenv("TASK1_SITEMAP_URL", SITEMAP_URL)
        self._status = IngestionStatus(state="idle")
        self._lock = Lock()
        self._job = DailyIngestionJob(self._runner, Path(database_path).with_suffix(".lock"))

    def _runner(self) -> CrawlRunner:
        manifest = ManifestStore(self.database_path)
        return _ClosingRunner(manifest, CrawlConfig(max_articles=int(os.getenv("TASK1_MAX_ARTICLES", "10"))), self.sitemap_url)

    def run(self, request_id: str) -> IngestionStatus:
        with self._lock:
            self._status = IngestionStatus(state="running", run_id=request_id)
        try:
            report = self._job.run()
            status = IngestionStatus(report.state, report.run_id, report.added, report.updated, report.unchanged, report.removed, report.failed, report.error)
        except Exception as exc:
            status = IngestionStatus("failed", request_id, error=str(exc))
        with self._lock:
            self._status = status
        return status

    def status(self) -> IngestionStatus:
        with self._lock:
            return self._status


class _ClosingRunner(CrawlRunner):
    def __init__(self, manifest: ManifestStore, config: CrawlConfig, sitemap_url: str) -> None:
        super().__init__(manifest, config=config)
        self.sitemap_url = sitemap_url

    def run(self):
        try:
            return super().run(self.sitemap_url)
        finally:
            self.manifest.close()


def main() -> None:
    from .indexed import IndexedQueryService

    database_path = os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3")
    query_service = IndexedQueryService(database_path)
    api = Task1Api(query_service=query_service, ingestion_service=LocalIngestionService(database_path))
    with make_server(os.getenv("TASK1_HOST", "127.0.0.1"), int(os.getenv("TASK1_PORT", "8001")), create_wsgi_app(api)) as server:
        print("Task 1 API listening on http://127.0.0.1:8001")
        server.serve_forever()


if __name__ == "__main__":
    main()
