"""Independent HTTP API contract for the Task 1 Knowledge Brain.

The default WSGI app is intended for local development on loopback only. A
deployed environment must add authentication and transport protection before
binding outside localhost.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
import json
from threading import Lock
from typing import Any, Callable, Iterable, Protocol
from uuid import uuid4
from .management import SitemapManager


MAX_BODY_BYTES = 1_000_000


@dataclass(frozen=True)
class SourceCitation:
    title: str
    url: str
    section: str | None = None
    chunk_id: str | None = None


@dataclass(frozen=True)
class QueryResult:
    answer: str | None
    status: str
    sources: tuple[SourceCitation, ...] = ()
    image_references: tuple[str, ...] = ()
    human_help_needed: bool = False
    retrieval_trace: tuple[str, ...] = ()


@dataclass(frozen=True)
class IngestionStatus:
    state: str
    run_id: str | None = None
    added: int = 0
    updated: int = 0
    unchanged: int = 0
    removed: int = 0
    failed: int = 0
    error: str | None = None


@dataclass(frozen=True)
class Escalation:
    escalation_id: str
    question: str
    reason: str
    evidence: tuple[SourceCitation, ...]
    status: str
    created_at: str
    resolved_at: str | None = None
    reviewer_answer: str | None = None


class QueryService(Protocol):
    def query(self, question: str, request_id: str) -> QueryResult: ...


class IngestionService(Protocol):
    def run(self, request_id: str) -> IngestionStatus: ...

    def status(self) -> IngestionStatus: ...


class SitemapService(Protocol):
    def add(self, owner_id: str, root_url: str, interval: str, threshold: int, action: str) -> Any: ...
    def list(self, owner_id: str) -> tuple[Any, ...]: ...
    def get(self, owner_id: str, sitemap_id: str) -> Any: ...
    def refresh(self, owner_id: str, sitemap_id: str) -> Any: ...
    def runs(self, owner_id: str, sitemap_id: str, limit: int = 20) -> tuple[Any, ...]: ...
    def pending(self, owner_id: str, sitemap_id: str) -> tuple[dict[str, object], ...]: ...
    def urls(self, owner_id: str, sitemap_id: str, run_id: str | None = None, limit: int = 500, offset: int = 0) -> tuple[dict[str, object], ...]: ...


class EscalationService(Protocol):
    def create(
        self, question: str, reason: str, evidence: tuple[SourceCitation, ...], request_id: str
    ) -> Escalation: ...

    def resolve(
        self, escalation_id: str, answer: str, reviewer: str, request_id: str
    ) -> Escalation | None: ...


class UnavailableQueryService:
    def query(self, question: str, request_id: str) -> QueryResult:
        return QueryResult(
            answer=None,
            status="retrieval_unavailable",
            human_help_needed=True,
            retrieval_trace=("retrieval service is not configured",),
        )


class NoopIngestionService:
    def run(self, request_id: str) -> IngestionStatus:
        return IngestionStatus(state="unavailable", error="ingestion service is not configured")

    def status(self) -> IngestionStatus:
        return IngestionStatus(state="unavailable", error="ingestion service is not configured")


class InMemoryEscalationService:
    def __init__(self, clock: Callable[[], str]) -> None:
        self.clock = clock
        self.records: dict[str, Escalation] = {}
        self.lock = Lock()

    def create(
        self, question: str, reason: str, evidence: tuple[SourceCitation, ...], request_id: str
    ) -> Escalation:
        record = Escalation(
            escalation_id=f"esc_{uuid4().hex}",
            question=question,
            reason=reason,
            evidence=evidence,
            status="open",
            created_at=self.clock(),
        )
        with self.lock:
            self.records[record.escalation_id] = record
        return record

    def resolve(
        self, escalation_id: str, answer: str, reviewer: str, request_id: str
    ) -> Escalation | None:
        with self.lock:
            record = self.records.get(escalation_id)
            if record is None:
                return None
            resolved = Escalation(
                escalation_id=record.escalation_id,
                question=record.question,
                reason=record.reason,
                evidence=record.evidence,
                status="resolved",
                created_at=record.created_at,
                resolved_at=self.clock(),
                reviewer_answer=answer,
            )
            self.records[escalation_id] = resolved
            return resolved


class Task1Api:
    """HTTP-independent API dispatcher used by the WSGI adapter and tests."""

    def __init__(
        self,
        query_service: QueryService | None = None,
        ingestion_service: IngestionService | None = None,
        escalation_service: EscalationService | None = None,
        sitemap_service: SitemapService | None = None,
        query_timeout_seconds: float = 10.0,
        clock: Callable[[], str] | None = None,
    ) -> None:
        if query_timeout_seconds <= 0:
            raise ValueError("query_timeout_seconds must be positive")
        self.query_service = query_service or UnavailableQueryService()
        self.ingestion_service = ingestion_service or NoopIngestionService()
        self.clock = clock or _now
        self.escalation_service = escalation_service or InMemoryEscalationService(self.clock)
        self.sitemap_service = sitemap_service
        self.query_timeout_seconds = query_timeout_seconds

    def dispatch(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        request_id: str | None = None,
    ) -> tuple[int, dict[str, Any], str]:
        request_id = request_id or f"req_{uuid4().hex}"
        try:
            if method == "GET" and path == "/health":
                return 200, {"status": "ok", "service": "task1-knowledge-brain"}, request_id
            if method == "POST" and path == "/query":
                return self._query(payload, request_id)
            if method == "POST" and path == "/ingestion/run":
                status = self.ingestion_service.run(request_id)
                return 200, _ingestion_payload(status), request_id
            if method == "GET" and path == "/ingestion/status":
                return 200, _ingestion_payload(self.ingestion_service.status()), request_id
            if method == "POST" and path == "/sitemaps/list":
                return self._sitemaps(payload, request_id)
            if method == "POST" and path == "/sitemaps":
                return self._add_sitemap(payload, request_id)
            if method == "POST" and path.startswith("/sitemaps/") and path.endswith("/refresh"):
                sitemap_id = path[len("/sitemaps/") : -len("/refresh")].strip("/")
                return self._refresh_sitemap(sitemap_id, payload, request_id)
            if method == "POST" and path.startswith("/sitemaps/") and path.endswith("/runs"):
                sitemap_id = path[len("/sitemaps/") : -len("/runs")].strip("/")
                return self._sitemap_runs(sitemap_id, payload, request_id)
            if method == "POST" and path.startswith("/sitemaps/") and path.endswith("/pending"):
                sitemap_id = path[len("/sitemaps/") : -len("/pending")].strip("/")
                return self._sitemap_pending(sitemap_id, payload, request_id)
            if method == "POST" and path.startswith("/sitemaps/") and path.endswith("/urls"):
                sitemap_id = path[len("/sitemaps/") : -len("/urls")].strip("/")
                return self._sitemap_urls(sitemap_id, payload, request_id)
            if method == "POST" and path == "/escalations":
                return self._create_escalation(payload, request_id)
            if method == "POST" and path.startswith("/escalations/") and path.endswith("/resolve"):
                escalation_id = path[len("/escalations/") : -len("/resolve")].strip("/")
                return self._resolve_escalation(escalation_id, payload, request_id)
            if path in {"/query", "/ingestion/run", "/ingestion/status", "/escalations", "/health", "/sitemaps", "/sitemaps/list"} or path.startswith("/escalations/") or path.startswith("/sitemaps/"):
                return 405, _error("method_not_allowed", "HTTP method is not allowed", request_id), request_id
            return 404, _error("not_found", "Endpoint was not found", request_id), request_id
        except ServiceUnavailableError as exc:
            return 503, _error(exc.code, str(exc), request_id), request_id
        except KeyError as exc:
            return 404, _error("not_found", str(exc), request_id), request_id
        except ValueError as exc:
            return 400, _error("invalid_request", str(exc), request_id), request_id
        except RuntimeError as exc:
            return 409, _error("conflict", str(exc), request_id), request_id
        except Exception:
            return 500, _error("internal_error", "The service could not complete the request", request_id), request_id

    def _require_sitemaps(self) -> SitemapService:
        if self.sitemap_service is None:
            raise ServiceUnavailableError("sitemap management is not configured")
        return self.sitemap_service

    @staticmethod
    def _owner(payload: dict[str, Any] | None) -> str:
        return _required_string(payload, "owner_id", 200)

    def _sitemaps(self, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        records = self._require_sitemaps().list(self._owner(payload))
        return 200, {"sitemaps": [_sitemap_payload(item) for item in records], "request_id": request_id}, request_id

    def _add_sitemap(self, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        if payload is None:
            raise ValueError("request body is required")
        service = self._require_sitemaps()
        record = service.add(
            self._owner(payload),
            _required_string(payload, "root_url", 2_000),
            str(payload.get("interval", "daily")),
            int(payload.get("threshold", 3)),
            str(payload.get("action", "review")),
        )
        return 201, {"sitemap": _sitemap_payload(record), "request_id": request_id}, request_id

    def _refresh_sitemap(self, sitemap_id: str, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        run = self._require_sitemaps().refresh(self._owner(payload), sitemap_id)
        return 200, {"run": _refresh_payload(run), "request_id": request_id}, request_id

    def _sitemap_runs(self, sitemap_id: str, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        runs = self._require_sitemaps().runs(self._owner(payload), sitemap_id)
        return 200, {"runs": [_refresh_payload(item) for item in runs], "request_id": request_id}, request_id

    def _sitemap_pending(self, sitemap_id: str, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        pending = self._require_sitemaps().pending(self._owner(payload), sitemap_id)
        return 200, {"pending": list(pending), "request_id": request_id}, request_id

    def _sitemap_urls(self, sitemap_id: str, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        payload = payload or {}
        urls = self._require_sitemaps().urls(
            self._owner(payload), sitemap_id,
            payload.get("run_id") if isinstance(payload.get("run_id"), str) else None,
            int(payload.get("limit", 500)), int(payload.get("offset", 0)),
        )
        return 200, {"urls": list(urls), "request_id": request_id}, request_id

    def _query(self, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        question = _required_string(payload, "question", 10_000)
        executor = ThreadPoolExecutor(max_workers=1)
        future = executor.submit(self.query_service.query, question, request_id)
        try:
            result = future.result(timeout=self.query_timeout_seconds)
        except FutureTimeout:
            future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
            return 504, _error("service_timeout", "The query timed out", request_id), request_id
        except ServiceUnavailableError as exc:
            executor.shutdown(wait=True)
            return 503, _error(exc.code, str(exc), request_id), request_id
        except Exception:
            executor.shutdown(wait=True)
            raise
        else:
            executor.shutdown(wait=True)
        status_code = 200 if result.status in {"answered", "insufficient_evidence"} else 503
        return status_code, {
            "answer": result.answer,
            "status": result.status,
            "sources": [_citation_payload(source) for source in result.sources],
            "image_references": list(result.image_references),
            "human_help_needed": result.human_help_needed,
            "request_id": request_id,
            "retrieval_trace": list(result.retrieval_trace),
        }, request_id

    def _create_escalation(self, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        question = _required_string(payload, "question", 10_000)
        reason = _required_string(payload, "reason", 1_000)
        evidence = _citations(payload.get("evidence", []) if payload else [])
        record = self.escalation_service.create(question, reason, evidence, request_id)
        return 201, _escalation_payload(record, request_id), request_id

    def _resolve_escalation(self, escalation_id: str, payload: dict[str, Any] | None, request_id: str) -> tuple[int, dict[str, Any], str]:
        answer = _required_string(payload, "answer", 20_000)
        reviewer = _required_string(payload, "reviewer", 200)
        record = self.escalation_service.resolve(escalation_id, answer, reviewer, request_id)
        if record is None:
            return 404, _error("escalation_not_found", "Escalation was not found", request_id), request_id
        return 200, _escalation_payload(record, request_id), request_id


class ServiceUnavailableError(RuntimeError):
    def __init__(self, message: str, code: str = "service_unavailable") -> None:
        super().__init__(message)
        self.code = code


def create_wsgi_app(api: Task1Api | None = None) -> Callable[..., Iterable[bytes]]:
    """Create a WSGI app; deploy locally on 127.0.0.1 until auth is added."""

    api = api or Task1Api()

    def application(environ: dict[str, Any], start_response: Callable[..., Any]) -> list[bytes]:
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = environ.get("PATH_INFO", "/")
        request_id = environ.get("HTTP_X_REQUEST_ID") or f"req_{uuid4().hex}"
        if method == "GET" and path == "/":
            encoded = _knowledge_chat_html().encode("utf-8")
            start_response("200 OK", [("Content-Type", "text/html; charset=utf-8"), ("Content-Length", str(len(encoded)))])
            return [encoded]
        payload: dict[str, Any] | None = None
        if method == "POST":
            try:
                length = int(environ.get("CONTENT_LENGTH", "0") or "0")
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                status, body, response_id = 400, _error("invalid_body", "Request body is invalid or too large", request_id), request_id
            else:
                raw = environ.get("wsgi.input").read(length)
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                    if not isinstance(payload, dict):
                        raise ValueError
                    status, body, response_id = api.dispatch(method, path, payload, request_id)
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    status, body, response_id = 400, _error("invalid_json", "Request body must be a JSON object", request_id), request_id
        else:
            status, body, response_id = api.dispatch(method, path, None, request_id)
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        reason = _STATUS_REASONS.get(status, "Unknown")
        start_response(
            f"{status} {reason}",
            [("Content-Type", "application/json"), ("Content-Length", str(len(encoded))), ("X-Request-ID", response_id)],
        )
        return [encoded]

    return application


def openapi_document() -> dict[str, Any]:
    """Return the public contract without exposing internal service classes."""
    return {
        "openapi": "3.0.3",
        "info": {"title": "Task 1 Knowledge Brain API", "version": "0.1.0"},
        "servers": [{"url": "http://127.0.0.1:8001", "description": "Local development only; no auth"}],
        "paths": {
            "/query": {"post": {"operationId": "queryKnowledge", "responses": {"200": {"description": "Grounded answer or insufficient evidence"}, "400": {"description": "Invalid request"}, "503": {"description": "Model or retrieval unavailable"}}}},
            "/ingestion/run": {"post": {"operationId": "startIngestion", "responses": {"200": {"description": "Ingestion status"}}}},
            "/ingestion/status": {"get": {"operationId": "getIngestionStatus", "responses": {"200": {"description": "Ingestion status"}}}},
            "/escalations": {"post": {"operationId": "createEscalation", "responses": {"201": {"description": "Created escalation"}}}},
            "/escalations/{id}/resolve": {"post": {"operationId": "resolveEscalation", "responses": {"200": {"description": "Resolved escalation"}, "404": {"description": "Not found"}}}},
            "/health": {"get": {"operationId": "health", "responses": {"200": {"description": "Healthy"}}}},
            "/sitemaps/list": {"post": {"operationId": "listSitemaps", "responses": {"200": {"description": "Owned sitemap configurations"}}}},
            "/sitemaps": {"post": {"operationId": "addSitemap", "responses": {"201": {"description": "Created sitemap configuration"}}}},
            "/sitemaps/{id}/refresh": {"post": {"operationId": "refreshSitemap", "responses": {"200": {"description": "Refresh run summary"}}}},
            "/sitemaps/{id}/runs": {"post": {"operationId": "listSitemapRuns", "responses": {"200": {"description": "Refresh history"}}}},
            "/sitemaps/{id}/pending": {"post": {"operationId": "pendingSitemapActions", "responses": {"200": {"description": "Pending lifecycle actions"}}}},
            "/sitemaps/{id}/urls": {"post": {"operationId": "listRefreshUrls", "responses": {"200": {"description": "Persisted URL results"}}}},
        },
    }


def _required_string(payload: dict[str, Any] | None, key: str, max_length: int) -> str:
    value = payload.get(key) if payload else None
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _citations(value: Any) -> tuple[SourceCitation, ...]:
    if not isinstance(value, list):
        raise ValueError("evidence must be a list")
    result: list[SourceCitation] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("evidence entries must be objects")
        result.append(SourceCitation(
            title=_required_string(item, "title", 500),
            url=_required_string(item, "url", 2_000),
            section=item.get("section"),
            chunk_id=item.get("chunk_id"),
        ))
    return tuple(result)


def _citation_payload(citation: SourceCitation) -> dict[str, str | None]:
    return {"title": citation.title, "url": citation.url, "section": citation.section, "chunk_id": citation.chunk_id}


def _ingestion_payload(status: IngestionStatus) -> dict[str, Any]:
    return {"state": status.state, "run_id": status.run_id, "added": status.added, "updated": status.updated, "unchanged": status.unchanged, "removed": status.removed, "failed": status.failed, "error": status.error}


def _escalation_payload(record: Escalation, request_id: str) -> dict[str, Any]:
    return {"escalation_id": record.escalation_id, "question": record.question, "reason": record.reason, "evidence": [_citation_payload(item) for item in record.evidence], "status": record.status, "created_at": record.created_at, "resolved_at": record.resolved_at, "reviewer_answer": record.reviewer_answer, "request_id": request_id}


def _sitemap_payload(record: Any) -> dict[str, Any]:
    return {
        "sitemap_id": record.sitemap_id, "owner_id": record.owner_id, "root_url": record.root_url,
        "interval": record.interval, "threshold": record.threshold, "action": record.action,
        "active": record.active, "created_at": record.created_at, "last_attempted": record.last_attempted,
        "last_successful": record.last_successful, "next_scheduled": record.next_scheduled,
        "status": record.status, "failure_reason": record.failure_reason,
    }


def _refresh_payload(record: Any) -> dict[str, Any]:
    return {
        "run_id": record.run_id, "sitemap_id": record.sitemap_id, "started_at": record.started_at,
        "completed_at": record.completed_at, "status": record.status,
        "discovered_count": record.discovered_count, "unique_count": record.unique_count,
        "duplicate_count": record.duplicate_count, "error_count": record.error_count,
        "pages_processed": record.pages_processed, "pages_total": record.pages_total,
        "first_fetched_url": record.first_fetched_url,
        "last_fetched_url": record.last_fetched_url,
        "errors": list(record.errors),
    }


def _error(code: str, message: str, request_id: str) -> dict[str, str]:
    return {"error": code, "message": message, "request_id": request_id}


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


_STATUS_REASONS = {200: "OK", 201: "Created", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 503: "Service Unavailable", 504: "Gateway Timeout"}


def _knowledge_chat_html() -> str:
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Knowledge Brain</title><style>
:root{font-family:system-ui,sans-serif;color:#17202a;background:#eef3f5}body{margin:0}.shell{max-width:880px;margin:0 auto;padding:48px 24px}.eyebrow{color:#147d92;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px}.panel{background:#fff;border:1px solid #d5e0e4;border-radius:10px;padding:24px;box-shadow:0 8px 24px #17304214}h1{margin:8px 0 10px;font-size:36px}p{line-height:1.55}textarea{width:100%;box-sizing:border-box;min-height:120px;border:1px solid #b8c9cf;border-radius:6px;padding:12px;font:inherit;resize:vertical}button{margin-top:12px;background:#147d92;color:#fff;border:0;border-radius:6px;padding:11px 16px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.6}.result{margin-top:24px;border-top:1px solid #d5e0e4;padding-top:20px}.status{font-weight:700;color:#147d92}.citation{margin:8px 0;padding:10px;background:#f3f8f9;border-left:3px solid #f28f3b}.muted{color:#587078}.error{color:#a33b2d}</style></head>
<body><main class="shell"><div class="eyebrow">Task 1 · Knowledge Brain</div><h1>Ask the support knowledge base</h1><p class="muted">Answers are shown with source evidence. Unsupported questions are sent for human review.</p><section class="panel"><label for="question"><strong>Your question</strong></label><textarea id="question" placeholder="How do I configure my directory?"></textarea><button id="ask">Ask Knowledge Brain</button><div id="result" class="result" hidden></div></section></main>
<script>const question=document.querySelector('#question'),ask=document.querySelector('#ask'),result=document.querySelector('#result');ask.addEventListener('click',async()=>{const value=question.value.trim();if(!value){result.hidden=false;result.innerHTML='<p class="error">Enter a question.</p>';return}ask.disabled=true;result.hidden=false;result.innerHTML='<p class="muted">Checking the knowledge service...</p>';try{const response=await fetch('/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:value})});const data=await response.json();const citations=(data.sources||[]).map(source=>'<div class="citation"><strong>'+escapeHtml(source.title||'Source')+'</strong><br><a href="'+escapeHtml(source.url||'#')+'" target="_blank" rel="noreferrer">'+escapeHtml(source.url||'')+'</a>'+(source.section?'<br><span class="muted">'+escapeHtml(source.section)+'</span>':'')+'</div>').join('');result.innerHTML='<p class="status">'+escapeHtml(data.status||'unknown')+'</p><p>'+escapeHtml(data.answer||'No supported answer was found.')+'</p>'+(data.human_help_needed?'<p class="error">Human review is needed.</p>':'')+(citations?'<h3>Sources</h3>'+citations:'')}catch(error){result.innerHTML='<p class="error">The knowledge service is unavailable.</p>'}finally{ask.disabled=false}});function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}</script></body></html>"""
