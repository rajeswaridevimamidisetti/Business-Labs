from io import BytesIO
import json
import time
import unittest
from types import SimpleNamespace

from knowledge_brain.api import (
    IngestionStatus,
    QueryResult,
    ServiceUnavailableError,
    SourceCitation,
    Task1Api,
    create_wsgi_app,
    openapi_document,
)


class FakeQueryService:
    def __init__(self, result: QueryResult | None = None, error: Exception | None = None, delay: float = 0) -> None:
        self.result = result
        self.error = error
        self.delay = delay

    def query(self, question: str, request_id: str) -> QueryResult:
        if self.delay:
            time.sleep(self.delay)
        if self.error:
            raise self.error
        assert self.result is not None
        return self.result


class FakeIngestion:
    def run(self, request_id: str) -> IngestionStatus:
        return IngestionStatus(state="completed", run_id="run-1", added=1)

    def status(self) -> IngestionStatus:
        return IngestionStatus(state="idle")


class ApiContractTest(unittest.TestCase):
    def test_health_and_openapi_expose_public_contract(self) -> None:
        api = Task1Api()
        status, body, request_id = api.dispatch("GET", "/health", None, "req-health")

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(request_id, "req-health")
        self.assertEqual(set(openapi_document()["paths"]), {
            "/query", "/ingestion/run", "/ingestion/status", "/escalations",
            "/escalations/{id}/resolve", "/health", "/sitemaps/list", "/sitemaps",
            "/sitemaps/{id}/refresh", "/sitemaps/{id}/runs", "/sitemaps/{id}/pending",
            "/sitemaps/{id}/urls", "/sitemaps/{id}/stats", "/sitemap-data/stats",
            "/sitemap-data/urls", "/sitemap-data/refresh", "/sitemap-data/export",
        })

    def test_query_returns_grounded_fields_without_confidence(self) -> None:
        query = FakeQueryService(QueryResult(
            answer="Use the settings page.",
            status="answered",
            sources=(SourceCitation("Settings", "https://support.example/article", "Setup", "c1"),),
            image_references=("https://support.example/settings.png",),
        ))
        api = Task1Api(query_service=query)

        status, body, _ = api.dispatch("POST", "/query", {"question": "How do I configure this?"}, "req-query")

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "answered")
        self.assertEqual(body["sources"][0]["chunk_id"], "c1")
        self.assertEqual(body["image_references"], ["https://support.example/settings.png"])
        self.assertNotIn("confidence", body)

    def test_invalid_input_and_unknown_routes_have_useful_errors(self) -> None:
        api = Task1Api()

        invalid_status, invalid, _ = api.dispatch("POST", "/query", {"question": ""}, "req-invalid")
        missing_status, missing, _ = api.dispatch("GET", "/missing", None, "req-missing")

        self.assertEqual(invalid_status, 400)
        self.assertEqual(invalid["error"], "invalid_request")
        self.assertEqual(missing_status, 404)
        self.assertEqual(missing["error"], "not_found")

    def test_unavailable_model_or_storage_is_not_fabricated(self) -> None:
        query = FakeQueryService(error=ServiceUnavailableError("Claude is unavailable", "model_unavailable"))
        api = Task1Api(query_service=query)

        status, body, _ = api.dispatch("POST", "/query", {"question": "What is supported?"}, "req-failure")

        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "model_unavailable")
        self.assertNotIn("answer", body)

    def test_insufficient_evidence_is_explicit(self) -> None:
        api = Task1Api(query_service=FakeQueryService(QueryResult(
            answer=None, status="insufficient_evidence", human_help_needed=True,
        )))

        status, body, _ = api.dispatch("POST", "/query", {"question": "Unsupported question?"}, "req-abstain")

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "insufficient_evidence")
        self.assertTrue(body["human_help_needed"])
        self.assertIsNone(body["answer"])

    def test_query_timeout_is_bounded(self) -> None:
        api = Task1Api(query_service=FakeQueryService(delay=0.05), query_timeout_seconds=0.001)

        status, body, _ = api.dispatch("POST", "/query", {"question": "Will this time out?"}, "req-timeout")

        self.assertEqual(status, 504)
        self.assertEqual(body["error"], "service_timeout")

    def test_ingestion_status_and_escalation_lifecycle(self) -> None:
        api = Task1Api(ingestion_service=FakeIngestion(), clock=lambda: "fixed-time")
        run_status, run_body, _ = api.dispatch("POST", "/ingestion/run", {}, "req-run")
        create_status, created, _ = api.dispatch("POST", "/escalations", {
            "question": "Can a reviewer answer this?",
            "reason": "insufficient_evidence",
            "evidence": [],
        }, "req-create")
        resolve_status, resolved, _ = api.dispatch("POST", f"/escalations/{created['escalation_id']}/resolve", {
            "answer": "A reviewed answer.", "reviewer": "expert-1",
        }, "req-resolve")

        self.assertEqual((run_status, run_body["state"]), (200, "completed"))
        self.assertEqual(create_status, 201)
        self.assertEqual(resolve_status, 200)
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(resolved["reviewer_answer"], "A reviewed answer.")

    def test_sitemap_management_routes_preserve_owner_and_refresh_summary(self) -> None:
        record = SimpleNamespace(
            sitemap_id="sm-1", owner_id="owner-1", root_url="https://docs.example.test/sitemap.xml",
            interval="daily", threshold=3, action="review", active=True, created_at="now",
            last_attempted=None, last_successful=None, next_scheduled="later",
            status="idle", failure_reason=None,
        )
        run = SimpleNamespace(
            run_id="run-1", sitemap_id="sm-1", started_at="start", completed_at="end",
            status="completed", discovered_count=2, unique_count=1, duplicate_count=1,
            error_count=0, pages_processed=1, pages_total=1, errors=(),
            first_fetched_url="https://docs.example.test/page",
            last_fetched_url="https://docs.example.test/page",
        )

        class Sitemaps:
            def add(self, owner_id, root_url, interval, threshold, action):
                self.owner_id = owner_id
                return record
            def list(self, owner_id):
                assert owner_id == "owner-1"
                return (record,)
            def get(self, owner_id, sitemap_id):
                return record
            def refresh(self, owner_id, sitemap_id):
                return run
            def runs(self, owner_id, sitemap_id, limit=20):
                return (run,)
            def pending(self, owner_id, sitemap_id):
                return ()

        api = Task1Api(sitemap_service=Sitemaps())
        created, body, _ = api.dispatch("POST", "/sitemaps", {
            "owner_id": "owner-1", "root_url": record.root_url,
        }, "req-sitemap")
        refreshed, refresh_body, _ = api.dispatch("POST", "/sitemaps/sm-1/refresh", {
            "owner_id": "owner-1",
        }, "req-refresh")
        self.assertEqual(created, 201)
        self.assertEqual(body["sitemap"]["sitemap_id"], "sm-1")
        self.assertEqual(refreshed, 200)
        self.assertEqual(refresh_body["run"]["duplicate_count"], 1)

    def test_sitemap_inventory_routes_validate_filters_and_export(self) -> None:
        record = SimpleNamespace(sitemap_id="sm-1", owner_id="owner-1")

        class Sitemaps:
            def list(self, owner_id):
                return (record,)
            def extraction_stats(self, owner_id):
                return {"available": True, "unique_sitemap_urls": 3}
            def extraction_urls(self, owner_id, **kwargs):
                assert kwargs["url_type"] == "article"
                return ({"url": "https://support.example/article", "is_article": True},)
            def extraction_url_count(self, owner_id, **kwargs):
                return 1
            def extraction_export(self, owner_id, **kwargs):
                return {"filename": "article-urls.txt", "content_type": "text/plain", "content": "https://support.example/article\n"}
            def refresh_extraction(self, owner_id, sitemap_id):
                return {"report": {"unique_sitemap_urls": 3}}

        api = Task1Api(sitemap_service=Sitemaps())
        status, body, _ = api.dispatch("POST", "/sitemap-data/urls", {"owner_id": "owner-1", "url_type": "article", "limit": 25}, "req-urls")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 1)
        export_status, export_body, _ = api.dispatch("POST", "/sitemap-data/export", {"owner_id": "owner-1", "url_type": "article", "format": "txt"}, "req-export")
        self.assertEqual(export_status, 200)
        self.assertEqual(export_body["export"]["filename"], "article-urls.txt")
        refresh_status, refresh_body, _ = api.dispatch("POST", "/sitemap-data/refresh", {"owner_id": "owner-1", "sitemap_id": "sm-1"}, "req-refresh-discovery")
        self.assertEqual(refresh_status, 200)
        self.assertEqual(refresh_body["refresh"]["report"]["unique_sitemap_urls"], 3)
        invalid_status, invalid_body, _ = api.dispatch("POST", "/sitemap-data/urls", {"owner_id": "owner-1", "url_type": "bad"}, "req-invalid-filter")
        self.assertEqual(invalid_status, 400)
        self.assertEqual(invalid_body["error"], "invalid_request")

    def test_wsgi_adapter_is_independent_of_internal_modules(self) -> None:
        app = create_wsgi_app(Task1Api())
        captured: list[tuple[str, list[tuple[str, str]]]] = []

        def start_response(status: str, headers: list[tuple[str, str]]) -> None:
            captured.append((status, headers))

        body = b'{"question":"What is known?"}'
        response = app({
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/query",
            "CONTENT_LENGTH": str(len(body)),
            "wsgi.input": BytesIO(body),
            "HTTP_X_REQUEST_ID": "req-http",
        }, start_response)

        self.assertTrue(captured[0][0].startswith("503 "))
        self.assertEqual(json.loads(response[0])["request_id"], "req-http")

    def test_root_serves_knowledge_chat_ui(self) -> None:
        app = create_wsgi_app(Task1Api())
        captured: list[str] = []

        def start_response(status: str, headers: list[tuple[str, str]]) -> None:
            captured.append(status)

        response = app({"REQUEST_METHOD": "GET", "PATH_INFO": "/", "wsgi.input": BytesIO()}, start_response)

        self.assertEqual(captured, ["200 OK"])
        self.assertIn(b"Knowledge Brain", response[0])
        self.assertIn(b"/query", response[0])


if __name__ == "__main__":
    unittest.main()
