from pathlib import Path
import tempfile
import unittest

from knowledge_brain.crawl import (
    CrawlConfig,
    CrawlRunner,
    FetchResponse,
    ManifestStore,
)


ROOT = "https://support.brilliantdirectories.com/support/sitemap.xml"
PAGE_A = "https://support.brilliantdirectories.com/support/a"
PAGE_B = "https://support.brilliantdirectories.com/support/b"


def urlset(*urls: str, last_modified: str | None = None) -> bytes:
    lastmod = f"<lastmod>{last_modified}</lastmod>" if last_modified else ""
    body = "".join(f"<url><loc>{url}</loc>{lastmod}</url>" for url in urls)
    return f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'.encode()


class MappingFetcher:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, url: str, timeout_seconds: float) -> FetchResponse:
        self.calls.append(url)
        response = self.responses[url]
        if isinstance(response, list):
            item = response.pop(0)
        else:
            item = response
        if isinstance(item, Exception):
            raise item
        return item


class CrawlRunnerTest(unittest.TestCase):
    def make_runner(
        self,
        fetcher: MappingFetcher,
        database_path: str,
        **config_overrides: object,
    ) -> tuple[CrawlRunner, ManifestStore]:
        manifest = ManifestStore(database_path)
        config = CrawlConfig(max_concurrency=1, **config_overrides)
        return CrawlRunner(manifest, fetcher, lambda url: True, config, sleep=lambda _: None), manifest

    def test_retries_transient_failures_with_bounded_attempts(self) -> None:
        fetcher = MappingFetcher(
            {
                ROOT: FetchResponse(200, urlset(PAGE_A)),
                PAGE_A: [
                    FetchResponse(503, b"temporary"),
                    FetchResponse(503, b"temporary"),
                    FetchResponse(200, b"article"),
                ],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"), backoff_seconds=0)
            result = runner.run()

            self.assertEqual(result.outcomes[0].status, "new")
            self.assertEqual(result.outcomes[0].attempts, 3)
            self.assertEqual(fetcher.calls.count(PAGE_A), 3)
            manifest.close()

    def test_permanent_failure_is_not_retried_indefinitely(self) -> None:
        fetcher = MappingFetcher({ROOT: FetchResponse(200, urlset(PAGE_A)), PAGE_A: FetchResponse(404, b"")})
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"), max_retries=5)
            result = runner.run()

            self.assertEqual(result.outcomes[0].status, "failed")
            self.assertEqual(result.outcomes[0].attempts, 1)
            self.assertEqual(fetcher.calls.count(PAGE_A), 1)
            manifest.close()

    def test_checkpoint_status_is_resumable(self) -> None:
        fetcher = MappingFetcher({ROOT: FetchResponse(200, urlset(PAGE_A)), PAGE_A: FetchResponse(200, b"article")})
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            manifest = ManifestStore(database)
            manifest.mark_started(PAGE_A)
            self.assertEqual(manifest.source(PAGE_A)["status"], "in_progress")
            manifest.close()

            runner, resumed_manifest = self.make_runner(fetcher, database)
            result = runner.run()

            self.assertEqual(result.outcomes[0].status, "new")
            self.assertEqual(resumed_manifest.source(PAGE_A)["active"], 1)
            resumed_manifest.close()

    def test_unchanged_reprocessing_is_idempotent(self) -> None:
        fetcher = MappingFetcher({ROOT: FetchResponse(200, urlset(PAGE_A)), PAGE_A: FetchResponse(200, b"same")})
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"))
            first = runner.run()
            second = runner.run()

            self.assertEqual(first.outcomes[0].status, "new")
            self.assertEqual(second.outcomes[0].status, "unchanged")
            self.assertEqual(manifest.version_count(PAGE_A), 1)
            manifest.close()

    def test_sitemap_last_modified_is_persisted_when_page_has_no_header(self) -> None:
        fetcher = MappingFetcher(
            {
                ROOT: FetchResponse(200, urlset(PAGE_A, last_modified="2026-10-15")),
                PAGE_A: FetchResponse(200, b"article"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"))
            runner.run()

            self.assertEqual(manifest.source(PAGE_A)["last_modified"], "2026-10-15")
            manifest.close()

    def test_one_page_failure_does_not_block_another(self) -> None:
        fetcher = MappingFetcher(
            {
                ROOT: FetchResponse(200, urlset(PAGE_A, PAGE_B)),
                PAGE_A: FetchResponse(404, b""),
                PAGE_B: FetchResponse(200, b"good"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"))
            result = runner.run()

            statuses = {outcome.url: outcome.status for outcome in result.outcomes}
            self.assertEqual(statuses, {PAGE_A: "failed", PAGE_B: "new"})
            manifest.close()

    def test_changed_and_removed_urls_are_recorded(self) -> None:
        first_fetcher = MappingFetcher(
            {ROOT: FetchResponse(200, urlset(PAGE_A, PAGE_B)), PAGE_A: FetchResponse(200, b"old"), PAGE_B: FetchResponse(200, b"keep")}
        )
        second_fetcher = MappingFetcher(
            {ROOT: FetchResponse(200, urlset(PAGE_A)), PAGE_A: FetchResponse(200, b"new")}
        )
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            first_runner, manifest = self.make_runner(first_fetcher, database)
            first_runner.run()
            manifest.close()

            second_runner, resumed_manifest = self.make_runner(second_fetcher, database)
            result = second_runner.run()

            self.assertEqual(result.outcomes[0].status, "changed")
            self.assertEqual(result.removed_count, 1)
            self.assertEqual(resumed_manifest.source(PAGE_B)["active"], 0)
            self.assertEqual(resumed_manifest.source(PAGE_B)["status"], "removed")
            resumed_manifest.close()

    def test_configured_rate_limit_is_applied_between_requests(self) -> None:
        fetcher = MappingFetcher(
            {
                ROOT: FetchResponse(200, urlset(PAGE_A, PAGE_B)),
                PAGE_A: FetchResponse(200, b"a"),
                PAGE_B: FetchResponse(200, b"b"),
            }
        )
        delays: list[float] = []
        with tempfile.TemporaryDirectory() as directory:
            manifest = ManifestStore(str(Path(directory) / "manifest.db"))
            config = CrawlConfig(max_concurrency=1, request_delay_seconds=0.25)
            runner = CrawlRunner(manifest, fetcher, lambda url: True, config, sleep=delays.append)
            runner.run()

            self.assertTrue(any(delay > 0 for delay in delays))
            manifest.close()

    def test_nested_index_is_traversed_to_multiple_levels_and_summarized(self) -> None:
        child = "https://support.brilliantdirectories.com/support/child.xml"
        grandchild = "https://support.brilliantdirectories.com/support/grandchild.xml"
        fetcher = MappingFetcher(
            {
                ROOT: FetchResponse(200, f"<sitemapindex><sitemap><loc>{child}</loc></sitemap></sitemapindex>".encode()),
                child: FetchResponse(200, f"<sitemapindex><sitemap><loc>{grandchild}</loc></sitemap></sitemapindex>".encode()),
                grandchild: FetchResponse(200, urlset(PAGE_A, PAGE_B)),
                PAGE_A: FetchResponse(200, b"a"),
                PAGE_B: FetchResponse(200, b"b"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            runner, manifest = self.make_runner(fetcher, str(Path(directory) / "manifest.db"))
            result = runner.run()
            self.assertEqual(result.discovered_count, 2)
            self.assertEqual(result.discovery_summary[-1].first_url, PAGE_A)
            self.assertEqual(result.discovery_summary[-1].last_url, PAGE_B)
            self.assertEqual(fetcher.calls.count(grandchild), 1)
            manifest.close()

    def test_failed_discovery_does_not_mark_existing_urls_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "manifest.db")
            first, manifest = self.make_runner(
                MappingFetcher({ROOT: FetchResponse(200, urlset(PAGE_A)), PAGE_A: FetchResponse(200, b"a")}),
                database,
            )
            first.run()
            manifest.close()
            second, resumed = self.make_runner(
                MappingFetcher({ROOT: RuntimeError("network down")}),
                database,
            )
            result = second.run()
            self.assertFalse(result.discovery_complete)
            self.assertEqual(resumed.source(PAGE_A)["consecutive_missing_checks"], 0)
            resumed.close()


if __name__ == "__main__":
    unittest.main()
