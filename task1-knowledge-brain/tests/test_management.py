from pathlib import Path
import tempfile
import unittest

from knowledge_brain.crawl import CrawlConfig, CrawlRunner, FetchResponse, ManifestStore
from knowledge_brain.management import RefreshScheduler, SitemapManager


ROOT = "https://support.brilliantdirectories.com/support/sitemap.xml"
PAGE = "https://support.brilliantdirectories.com/support/page"


class Fetcher:
    def __init__(self) -> None:
        self.responses = {
            ROOT: FetchResponse(200, f"<urlset><url><loc>{PAGE}</loc></url><url><loc>{PAGE}</loc></url></urlset>".encode()),
            PAGE: FetchResponse(200, b"page"),
        }

    def __call__(self, url: str, timeout: float) -> FetchResponse:
        return self.responses[url]


class ManagementTests(unittest.TestCase):
    def test_configuration_refresh_history_and_owner_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            fetcher = Fetcher()

            def factory(_config):
                return CrawlRunner(
                    ManifestStore(database), fetcher, lambda _url: True,
                    CrawlConfig(max_concurrency=1), sleep=lambda _seconds: None,
                )

            manager = SitemapManager(database, factory, clock=lambda: "2026-10-23T00:00:00+00:00")
            config = manager.add("user-a", ROOT, "weekly", 2, "quarantine")
            self.assertEqual(manager.list("user-b"), ())
            run = manager.refresh("user-a", config.sitemap_id)
            self.assertEqual(run.status, "completed")
            self.assertEqual(run.unique_count, 1)
            self.assertEqual(run.duplicate_count, 1)
            self.assertEqual(run.first_fetched_url, PAGE)
            self.assertEqual(manager.urls("user-a", config.sitemap_id)[0]["url"], PAGE)
            self.assertEqual(len(manager.runs("user-a", config.sitemap_id)), 1)
            manager.close()

    def test_invalid_configuration_and_private_root_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            manager = SitemapManager(database, lambda _config: None)
            with self.assertRaises(ValueError):
                manager.add("user-a", "http://127.0.0.1/sitemap.xml")
            with self.assertRaises(ValueError):
                manager.add("user-a", ROOT, "hourly")
            manager.close()

    def test_scheduler_can_be_started_and_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            manager = SitemapManager(database, lambda _config: None)
            scheduler = RefreshScheduler(manager, poll_seconds=0.01)
            scheduler.start()
            scheduler.start()
            scheduler.stop()
            manager.close()


if __name__ == "__main__":
    unittest.main()
