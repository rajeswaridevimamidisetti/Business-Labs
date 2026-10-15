from pathlib import Path
import unittest

from knowledge_brain.sitemap import SitemapParseError, parse_sitemap


FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class SitemapParserTest(unittest.TestCase):
    def test_valid_urlset_extracts_urls_and_last_modified(self) -> None:
        result = parse_sitemap(fixture("valid-urlset.xml"))

        self.assertEqual(result.kind, "urlset")
        self.assertEqual(
            result.entries,
            (
                parse_sitemap(
                    "<urlset><url><loc>https://support.brilliantdirectories.com/support/home</loc>"
                    "<lastmod>2026-10-11T08:00:54+00:00</lastmod></url></urlset>"
                ).entries[0],
                parse_sitemap(
                    "<urlset><url><loc>https://support.brilliantdirectories.com/support/solutions</loc></url></urlset>"
                ).entries[0],
            ),
        )

    def test_sitemap_index_returns_child_sitemaps_without_fetching(self) -> None:
        result = parse_sitemap(fixture("sitemap-index.xml"))

        self.assertEqual(result.kind, "sitemapindex")
        self.assertEqual(len(result.child_sitemaps), 2)
        self.assertEqual(result.entries, ())
        self.assertEqual(result.child_sitemaps[0].last_modified, "2026-10-10")

    def test_missing_fields_are_recorded_and_valid_entry_survives(self) -> None:
        result = parse_sitemap(fixture("missing-fields.xml"))

        self.assertEqual(len(result.entries), 1)
        self.assertEqual(result.skipped[0].reason, "missing_url")
        self.assertEqual(result.skipped[1].reason, "missing_url")

    def test_invalid_hosts_schemes_ports_and_duplicates_are_recorded(self) -> None:
        result = parse_sitemap(fixture("invalid-and-duplicates.xml"))

        self.assertEqual(len(result.entries), 1)
        self.assertEqual(
            [item.reason for item in result.skipped],
            [
                "unsupported_scheme",
                "host_not_approved",
                "non_default_port",
                "duplicate_url",
            ],
        )

    def test_alternate_namespace_and_host_case_are_supported(self) -> None:
        result = parse_sitemap(fixture("alternate-namespace.xml"))

        self.assertEqual(result.entries[0].url, "https://support.brilliantdirectories.com/support/alternate")

    def test_malformed_xml_raises_parse_error(self) -> None:
        with self.assertRaises(SitemapParseError):
            parse_sitemap("<urlset><url></urlset>")

    def test_unknown_root_raises_parse_error(self) -> None:
        with self.assertRaises(SitemapParseError):
            parse_sitemap("<feed><entry /></feed>")


if __name__ == "__main__":
    unittest.main()
