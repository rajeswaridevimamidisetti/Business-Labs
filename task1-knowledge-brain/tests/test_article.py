from pathlib import Path
import tempfile
import unittest

from knowledge_brain.article import parse_article


FIXTURES = Path(__file__).parent / "fixtures"
SOURCE_URL = "https://support.brilliantdirectories.com/support/source"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class ArticleParserTest(unittest.TestCase):
    def test_normalizes_article_structure_and_removes_boilerplate(self) -> None:
        article = parse_article(fixture("article.html"), SOURCE_URL)

        self.assertEqual(article.canonical_url, "https://support.brilliantdirectories.com/support/article-one")
        self.assertTrue(article.article_id.startswith("article-"))
        self.assertEqual(article.title, "Configure the Directory")
        self.assertIn("configure the directory", article.body_text.lower())
        self.assertNotIn("Home Navigation", article.body_text)
        self.assertEqual(article.headings[1].path, ("Configure the Directory", "Steps"))
        self.assertEqual(article.procedural_steps, ("Open settings.", "Save the configuration."))
        self.assertEqual(article.tables[0].headers, ("Option", "Value"))
        self.assertEqual(article.tables[0].rows, (("Mode", "Enabled"),))
        self.assertEqual(article.last_modified, "2026-10-15T10:00:00Z")
        self.assertEqual(
            [image.url for image in article.images],
            [
                "https://support.brilliantdirectories.com/support/images/settings.png",
                "https://support.brilliantdirectories.com/support/images/small.png",
            ],
        )

    def test_missing_title_is_reported(self) -> None:
        article = parse_article(fixture("missing-title.html"), SOURCE_URL)

        self.assertIsNone(article.title)
        self.assertIn("missing_title", article.warnings)

    def test_no_content_container_records_low_quality_warning(self) -> None:
        article = parse_article("<html><body><p>Loose body text</p></body></html>", SOURCE_URL)

        self.assertIn("low_quality_extraction:no_content_container", article.warnings)
        self.assertEqual(article.body_text, "Loose body text")

    def test_malformed_html_is_recovered_with_warning(self) -> None:
        article = parse_article(fixture("malformed-article.html"), SOURCE_URL)

        self.assertIn("Recoverable article", article.body_text)
        self.assertIn("malformed_html_recovered", article.warnings)

    def test_record_has_stable_hash_and_inspectable_json(self) -> None:
        article = parse_article(fixture("article.html"), SOURCE_URL, ingestion_timestamp="fixed-time")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized.json"
            article.save_json(output)

            saved = output.read_text(encoding="utf-8")
            self.assertIn('"content_hash"', saved)
            self.assertIn('"article_id"', saved)
            self.assertIn('"fixed-time"', saved)

        self.assertEqual(article.content_hash, parse_article(fixture("article.html"), SOURCE_URL).content_hash)


if __name__ == "__main__":
    unittest.main()
