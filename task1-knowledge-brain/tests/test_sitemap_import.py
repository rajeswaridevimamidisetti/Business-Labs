from pathlib import Path
import sqlite3
import tempfile
import unittest

from knowledge_brain.sitemap_import import (
    SitemapFetchError,
    extract_sitemap_file,
    extract_sitemap_xml,
    fetch_sitemap_collection,
    is_article_url,
    persist_fetched_sitemap,
)


SOURCE = "https://support.brilliantdirectories.com/support/sitemap.xml"
ARTICLE = "https://support.brilliantdirectories.com/support/solutions/articles/123/how-to-configure?view=full"


class SitemapImportTest(unittest.TestCase):
    def test_article_classification_preserves_query_parameters(self) -> None:
        self.assertTrue(is_article_url(ARTICLE))
        self.assertFalse(is_article_url("https://support.brilliantdirectories.com/support/solutions/"))
        self.assertFalse(is_article_url("https://support.brilliantdirectories.com/support/category"))

    def test_extracts_normalizes_deduplicates_and_persists_idempotently(self) -> None:
        xml = f"""<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
          <url><loc> {ARTICLE}#fragment </loc></url>
          <url><loc>{ARTICLE}</loc></url>
          <url><loc>https://support.brilliantdirectories.com/support/category</loc></url>
          <url><loc>mailto:invalid@example.com</loc></url>
        </urlset>"""
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "manifest.sqlite3"
            first = extract_sitemap_xml(xml, source_url=SOURCE, database_path=database, now="2026-10-23T00:00:00+00:00")
            second = extract_sitemap_xml(xml, source_url=SOURCE, database_path=database, now="2026-10-23T00:01:00+00:00")

            self.assertEqual(first.total_sitemap_urls, 4)
            self.assertEqual(first.unique_sitemap_urls, 2)
            self.assertEqual(first.article_urls_identified, 1)
            self.assertEqual(first.duplicate_urls_removed, 1)
            self.assertEqual(first.rejected_urls, 1)
            self.assertEqual(second.unique_article_urls_saved, 1)
            self.assertEqual(Path(first.all_urls_path).read_text(encoding="utf-8").splitlines(), [ARTICLE, "https://support.brilliantdirectories.com/support/category"])
            self.assertEqual(Path(first.article_urls_path).read_text(encoding="utf-8").splitlines(), [ARTICLE])
            connection = sqlite3.connect(database)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sitemap_source_urls").fetchone()[0], 2)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sitemap_imports").fetchone()[0], 2)
            connection.close()

    def test_file_extraction_writes_report(self) -> None:
        fixture = Path(__file__).parent / "fixtures" / "valid-urlset.xml"
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "report.json"
            report = extract_sitemap_file(fixture, source_url=SOURCE, database_path=Path(directory) / "db.sqlite3", report_path=report_path)
            self.assertTrue(report_path.exists())
            self.assertEqual(report.unique_sitemap_urls, 2)

    def test_live_collection_fetches_nested_indexes_without_fetching_articles(self) -> None:
        root = SOURCE
        child = "https://support.brilliantdirectories.com/support/sitemap-1.xml"
        article = ARTICLE
        category = "https://support.brilliantdirectories.com/support/category"
        documents = {
            root: f"<sitemapindex><sitemap><loc>{child}</loc></sitemap></sitemapindex>".encode(),
            child: f"<urlset><url><loc>{article}</loc></url><url><loc>{article}</loc></url><url><loc>{category}</loc></url></urlset>".encode(),
        }
        requested: list[str] = []

        def fetch(url: str, timeout: float) -> bytes:
            requested.append(url)
            return documents[url]

        collection = fetch_sitemap_collection(root, fetcher=fetch)

        self.assertEqual(collection.documents_fetched, 2)
        self.assertEqual(collection.total_url_entries, 3)
        self.assertEqual([entry.url for entry in collection.entries], [article, category])
        self.assertEqual(collection.duplicate_urls_removed, 1)
        self.assertEqual(requested, [root, child])
        self.assertNotIn(article, requested)

    def test_live_collection_rejects_unsafe_child_before_request(self) -> None:
        unsafe = "http://127.0.0.1/private.xml"
        root_document = f"<sitemapindex><sitemap><loc>{unsafe}</loc></sitemap></sitemapindex>".encode()
        requested: list[str] = []

        collection = fetch_sitemap_collection(
            SOURCE,
            fetcher=lambda url, timeout: (requested.append(url) or root_document),
        )

        self.assertEqual(collection.documents_fetched, 1)
        self.assertEqual(requested, [SOURCE])

    def test_fetched_collection_persists_files_and_report(self) -> None:
        collection = fetch_sitemap_collection(
            SOURCE,
            fetcher=lambda url, timeout: f"<urlset><url><loc>{ARTICLE}</loc></url></urlset>".encode(),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = persist_fetched_sitemap(
                collection,
                database_path=root / "manifest.sqlite3",
                report_path=root / "report.json",
            )
            self.assertEqual(report.total_sitemap_urls, 1)
            self.assertEqual(report.unique_article_urls_saved, 1)
            self.assertEqual((root / "sitemap-urls.txt").read_text(encoding="utf-8").splitlines(), [ARTICLE])
            self.assertEqual((root / "article-urls.txt").read_text(encoding="utf-8").splitlines(), [ARTICLE])
            connection = sqlite3.connect(root / "manifest.sqlite3")
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM sitemap_source_urls").fetchone()[0], 1)
            connection.close()
