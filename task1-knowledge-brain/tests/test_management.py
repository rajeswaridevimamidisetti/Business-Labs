from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from knowledge_brain.crawl import CrawlConfig, CrawlRunner, FetchResponse, ManifestStore
from knowledge_brain.management import RefreshScheduler, SitemapManager
from knowledge_brain.sitemap_import import FetchedSitemapCollection, SitemapFetchError, extract_sitemap_xml


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

    def test_extraction_inventory_filters_paginates_and_exports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "manifest.db"
            manager = SitemapManager(str(database), lambda _config: None)
            manager.add("user-a", ROOT)
            article_a = "https://support.brilliantdirectories.com/support/solutions/articles/a"
            article_b = "https://support.brilliantdirectories.com/support/solutions/articles/b"
            other = "https://support.brilliantdirectories.com/support/home"
            extract_sitemap_xml(
                f"<urlset><url><loc>{article_a}</loc></url><url><loc>{article_b}</loc></url><url><loc>{other}</loc></url></urlset>",
                source_url=ROOT, database_path=database,
            )
            self.assertEqual(manager.extraction_url_count("user-a"), 3)
            self.assertEqual(manager.extraction_url_count("user-a", url_type="article"), 2)
            self.assertEqual(manager.extraction_url_count("user-a", url_type="other"), 1)
            self.assertEqual(len(manager.extraction_urls("user-a", search="/home")), 1)
            row = manager.extraction_urls("user-a", limit=1)[0]
            self.assertEqual(row["source_url"], ROOT)
            self.assertIn("processing_status", row)
            export = manager.extraction_export("user-a", url_type="article", file_format="txt")
            self.assertEqual(export["filename"], "article-urls.txt")
            self.assertEqual(export["content"].splitlines(), [article_a, article_b])
            csv_export = manager.extraction_export("user-a", file_format="csv")
            self.assertIn("index,url,url_type", csv_export["content"])
            manager.close()

    def test_discovery_refresh_persists_report_without_article_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "manifest.db"
            manager = SitemapManager(str(database), lambda _config: None, clock=lambda: "2026-10-24T00:00:00+00:00")
            config = manager.add("user-a", ROOT)
            collection = FetchedSitemapCollection(ROOT, (), 0, 0, (), 1)
            report = SimpleNamespace(to_dict=lambda: {"unique_sitemap_urls": 0})
            with patch("knowledge_brain.management.fetch_sitemap_collection", return_value=collection) as fetch, patch("knowledge_brain.management.persist_fetched_sitemap", return_value=report):
                result = manager.refresh_extraction("user-a", config.sitemap_id)
            fetch.assert_called_once()
            self.assertEqual(result["report"]["unique_sitemap_urls"], 0)
            self.assertEqual(result["run_id"], manager.runs("user-a", config.sitemap_id)[0].run_id)
            self.assertEqual(manager.runs("user-a", config.sitemap_id)[0].pages_total, 1)
            self.assertEqual(manager.get("user-a", config.sitemap_id).status, "completed")
            manager.close()

    def test_discovery_refresh_failure_is_not_reported_successfully(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "manifest.db"
            manager = SitemapManager(str(database), lambda _config: None)
            config = manager.add("user-a", ROOT)
            with patch("knowledge_brain.management.fetch_sitemap_collection", side_effect=SitemapFetchError("malformed sitemap XML")):
                with self.assertRaises(SitemapFetchError):
                    manager.refresh_extraction("user-a", config.sitemap_id)
            self.assertEqual(manager.get("user-a", config.sitemap_id).status, "failed")
            manager.close()


if __name__ == "__main__":
    unittest.main()
