"""Local-only Task 1 API server entry point."""

import os
from pathlib import Path
from threading import Lock
from wsgiref.simple_server import make_server

from .api import IngestionService, IngestionStatus, Task1Api, create_wsgi_app
from .crawl import CrawlConfig, CrawlRunner, ManifestStore
from .management import RefreshScheduler, SitemapManager, SitemapConfig
from .operations import DailyIngestionJob
from .sitemap import SITEMAP_URL


class LocalIngestionService(IngestionService):
    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        self.sitemap_url = os.getenv("TASK1_SITEMAP_URL", SITEMAP_URL)
        self._status = IngestionStatus(state="idle")
        self._lock = Lock()
        self._job = DailyIngestionJob(self._runner, Path(database_path).with_suffix(".lock"))
        self.sitemaps = SitemapManager(database_path, self._managed_runner)
        self.scheduler = RefreshScheduler(
            self.sitemaps, float(os.getenv("TASK1_SCHEDULER_POLL_SECONDS", "30"))
        )
        self.scheduler.start()

    def _runner(self) -> CrawlRunner:
        manifest = ManifestStore(self.database_path)
        return _ClosingRunner(manifest, _crawl_config(), self.sitemap_url)

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

    def _managed_runner(self, config: SitemapConfig) -> CrawlRunner:
        manifest = ManifestStore(self.database_path)
        return _ClosingRunner(
            manifest,
            _crawl_config(),
            config.root_url,
        )

    def close(self) -> None:
        self.scheduler.stop()
        self.sitemaps.close()


class _ClosingRunner(CrawlRunner):
    def __init__(self, manifest: ManifestStore, config: CrawlConfig, sitemap_url: str) -> None:
        super().__init__(manifest, config=config)
        self.sitemap_url = sitemap_url

    def run(self, sitemap_url: str | None = None):
        try:
            return super().run(sitemap_url or self.sitemap_url)
        finally:
            self.manifest.close()


def _crawl_config() -> CrawlConfig:
    """Build production crawler settings without silently truncating imports."""
    raw_limit = os.getenv("TASK1_MAX_ARTICLES", "0").strip()
    limit = int(raw_limit) if raw_limit else 0
    if limit < 0:
        raise ValueError("TASK1_MAX_ARTICLES must be zero (unlimited) or positive")
    return CrawlConfig(
        max_articles=limit or None,
        article_path_fragment=os.getenv(
            "TASK1_ARTICLE_PATH_FRAGMENT", "/support/solutions/articles/"
        ).strip() or None,
    )


def main() -> None:
    from .indexed import IndexedQueryService

    database_path = os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3")
    manifest = ManifestStore(database_path)
    manifest.close()
    query_service = IndexedQueryService(database_path)
    ingestion = LocalIngestionService(database_path)
    api = Task1Api(
        query_service=query_service,
        ingestion_service=ingestion,
        sitemap_service=ingestion.sitemaps,
    )
    try:
        with make_server(os.getenv("TASK1_HOST", "127.0.0.1"), int(os.getenv("TASK1_PORT", "8001")), create_wsgi_app(api)) as server:
            print("Task 1 API listening on http://127.0.0.1:8001")
            server.serve_forever()
    finally:
        ingestion.close()


if __name__ == "__main__":
    main()
