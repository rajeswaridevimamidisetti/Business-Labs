import sqlite3
import tempfile
import unittest
from pathlib import Path

from knowledge_brain.api import QueryResult
from knowledge_brain.crawl import FetchResponse, ManifestStore
from knowledge_brain.indexed import IndexedQueryService, load_index
from knowledge_brain.server import DemoQueryService


class IndexedRetrievalTest(unittest.TestCase):
    def _database(self, html: bytes | None = None) -> str:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "manifest.sqlite3"
        manifest = ManifestStore(path)
        self.addCleanup(manifest.close)
        if html is not None:
            manifest.mark_started("https://support.brilliantdirectories.com/support/settings")
            manifest.record_success(
                "https://support.brilliantdirectories.com/support/settings",
                FetchResponse(200, html),
                1,
            )
        return str(path)

    def test_retrieves_indexed_article_and_real_citation(self) -> None:
        database = self._database(
            b"<article><h1>Settings</h1><p>Open account settings and save changes.</p></article>"
        )
        result = IndexedQueryService(database).query("How do I open settings?", "req-1")
        self.assertEqual(result.status, "answered")
        self.assertIn("Open account settings", result.answer or "")
        self.assertEqual(result.sources[0].url, "https://support.brilliantdirectories.com/support/settings")
        self.assertNotEqual(result.sources[0].chunk_id, "demo-chunk")
        self.assertTrue(result.retrieval_trace)

    def test_empty_index_abstains_without_sources(self) -> None:
        result = IndexedQueryService(self._database()).query("How do I open settings?", "req-2")
        self.assertEqual(result.status, "insufficient_evidence")
        self.assertIsNone(result.answer)
        self.assertEqual(result.sources, ())
        self.assertTrue(result.human_help_needed)

    def test_missing_index_is_unavailable(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "database does not exist"):
            load_index(Path(tempfile.gettempdir()) / "missing-business-labs-index.sqlite3")

    def test_demo_mode_is_explicit_and_marked(self) -> None:
        result = DemoQueryService().query("How do settings work?", "req-demo")
        self.assertTrue(result.demo_mode)
        self.assertEqual(result.retrieval_trace, ("demo-mode",))
        self.assertEqual(result.sources[0].title, "Demo support article")

    def test_corrupt_index_is_unavailable(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "manifest.sqlite3"
        path.write_text("not sqlite", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            load_index(path)


if __name__ == "__main__":
    unittest.main()
