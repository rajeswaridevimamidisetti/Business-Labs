"""Task 3 local HTTP smoke service using Task 1 only through its API."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .fixtures import synthetic_transcripts
from .models import Estimate, EstimationAgent, Feasibility, ProductFeasibilityAgent, Proposal, ProposalReviewAgent, ScopeAgent, TranscriptAnalyst, Requirement, ScopeDocument, parse_transcript
from .storage import ProposalStore
from .task1_client import Task1ClientError, Task1HttpClient


class Handler(BaseHTTPRequestHandler):
    proposals: dict[str, Proposal] = {}
    store = ProposalStore(os.getenv("TASK3_PROPOSAL_STORE", "data/proposals.json"))

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "task3-meeting-to-scope"})
            return
        if self.path == "/v1/transcripts":
            self._send(200, {"transcripts": [{"meeting_id": item.meeting_id, "project_id": item.project_id, "date": item.date, "text": item.text, "follow_up_to": item.follow_up_to} for item in synthetic_transcripts()]})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path.endswith("/approve") and self.path.startswith("/v1/proposals/"):
            proposal_id = self.path[len("/v1/proposals/") : -len("/approve")].strip("/")
            try:
                payload = self._read_json()
                reviewer = payload.get("reviewer")
                if not isinstance(reviewer, str) or not reviewer.strip():
                    raise ValueError("reviewer is required")
                proposal = self.proposals.get(proposal_id)
                if proposal is None:
                    record = self.store.latest(proposal_id)
                    proposal = _proposal_from_record(record) if record else None
                if proposal is None:
                    self._send(404, {"error": "proposal_not_found"})
                    return
                approved = ProposalReviewAgent().approve(proposal, reviewer, datetime.now(timezone.utc).isoformat())
                self.proposals[proposal_id] = approved
                self.store.save(approved)
                self._send(200, {"proposal": asdict(approved), "audit": {"reviewer": reviewer, "action": "approved"}})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"error": "invalid_request", "message": str(exc)})
            return
        if self.path == "/v1/scope":
            try:
                payload = self._read_json()
                text = payload.get("transcript")
                if not isinstance(text, str) or len(text.strip()) < 10:
                    raise ValueError("transcript must contain at least 10 characters")
                meeting_id = payload.get("meeting_id", "meeting-api")
                project_id = payload.get("project_id", "project-api")
                date = payload.get("date", "")
                if not all(isinstance(item, str) for item in (meeting_id, project_id, date)):
                    raise ValueError("meeting_id, project_id, and date must be strings")
                transcript = parse_transcript(meeting_id, project_id, date, text, payload.get("follow_up_to"))
                requirements = TranscriptAnalyst().analyze(transcript)
                client = Task1HttpClient(os.getenv("TASK1_BASE_URL", "http://127.0.0.1:8001"))
                feasibility = ProductFeasibilityAgent().check(requirements, client)
                scope = ScopeAgent().build(requirements, feasibility)
                estimates = EstimationAgent().estimate(scope)
                proposal = ProposalReviewAgent().create(f"proposal-{meeting_id}", scope, estimates)
                proposal = Proposal(proposal.proposal_id, proposal.version, proposal.scope, proposal.estimates, proposal.total_likely_hours, proposal.pricing_assumption, proposal.approval_status, project_id)
                self.proposals[proposal.proposal_id] = proposal
                self.store.save(proposal)
                self._send(200, {"requirements": [asdict(item) for item in requirements], "feasibility": [asdict(item) for item in feasibility], "estimates": [asdict(item) for item in estimates], "proposal": asdict(proposal), "changes": None})
            except Task1ClientError as exc:
                self._send(503, {"error": "task1_unavailable", "message": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"error": "invalid_request", "message": str(exc)})
            return
        if self.path == "/v1/scope/follow-up":
            try:
                payload = self._read_json()
                text = payload.get("transcript")
                project_id = payload.get("project_id")
                if not isinstance(text, str) or len(text.strip()) < 10 or not isinstance(project_id, str) or not project_id.strip():
                    raise ValueError("transcript and project_id are required")
                baseline_record = self.store.approved_baseline(project_id)
                if baseline_record is None:
                    self._send(409, {"error": "approved_baseline_required", "message": "Approve an initial proposal before submitting a follow-up."})
                    return
                baseline = _proposal_from_record(baseline_record)
                meeting_id = payload.get("meeting_id", "follow-up-api")
                date = payload.get("date", "")
                if not isinstance(meeting_id, str) or not isinstance(date, str):
                    raise ValueError("meeting_id and date must be strings")
                transcript = parse_transcript(meeting_id, project_id, date, text, baseline.proposal_id)
                requirements = TranscriptAnalyst().analyze(transcript)
                client = Task1HttpClient(os.getenv("TASK1_BASE_URL", "http://127.0.0.1:8001"))
                feasibility = ProductFeasibilityAgent().check(requirements, client)
                scope = ScopeAgent().build(requirements, feasibility)
                estimates = EstimationAgent().estimate(scope)
                revised = ProposalReviewAgent().create(baseline.proposal_id, scope, estimates, baseline.version + 1)
                revised = Proposal(revised.proposal_id, revised.version, revised.scope, revised.estimates, revised.total_likely_hours, revised.pricing_assumption, revised.approval_status, project_id)
                changes = ProposalReviewAgent().compare(baseline, revised)
                self.proposals[revised.proposal_id] = revised
                self.store.save(revised)
                self._send(200, {"requirements": [asdict(item) for item in requirements], "feasibility": [asdict(item) for item in feasibility], "estimates": [asdict(item) for item in estimates], "proposal": asdict(revised), "changes": asdict(changes), "baseline": {"proposal_id": baseline.proposal_id, "version": baseline.version, "approval_status": baseline.approval_status}})
            except Task1ClientError as exc:
                self._send(503, {"error": "task1_unavailable", "message": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send(400, {"error": "invalid_request", "message": str(exc)})
            return
        if self.path != "/v1/smoke/feasibility":
            self._send(404, {"error": "not_found"})
            return
        try:
            payload = self._read_json()
            question = payload["question"]
            if not isinstance(question, str) or not question.strip():
                raise ValueError("question is required")
            result = Task1HttpClient(os.getenv("TASK1_BASE_URL", "http://127.0.0.1:8001")).query(question, self.headers.get("x-request-id"))
            self._send(200, {"feasibility": "verified" if result.get("status") == "answered" and result.get("sources") else "unverified", "evidence": result.get("sources", []), "task1_status": result.get("status")})
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": "invalid_request", "message": str(exc)})
        except Task1ClientError as exc:
            self._send(503, {"error": "task1_unavailable", "message": str(exc)})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, object]:
        length = int(self.headers.get("content-length", "0"))
        if length > 1_000_000:
            raise ValueError("request body is too large")
        value = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("request body must be an object")
        return value


def main() -> None:
    host = os.getenv("TASK3_HOST", "127.0.0.1")
    port = int(os.getenv("TASK3_PORT", "8003"))
    with ThreadingHTTPServer((host, port), Handler) as server:
        print(f"Task 3 API listening on http://{host}:{port}")
        server.serve_forever()


def _proposal_from_record(record: dict | None) -> Proposal | None:
    if record is None:
        return None
    scope_data = record.get("scope", {})
    requirements = tuple(Requirement(**item) for item in scope_data.get("agreed_requirements", ()))
    scope = ScopeDocument(
        scope_data.get("project_objective", ""),
        scope_data.get("current_problem", ""),
        requirements,
        scope_data.get("proposed_solution", ""),
        tuple(scope_data.get("deliverables", ())),
        tuple(scope_data.get("exclusions", ())),
        tuple(scope_data.get("assumptions", ())),
        tuple(scope_data.get("dependencies", ())),
        tuple(scope_data.get("acceptance_criteria", ())),
        tuple(scope_data.get("client_responsibilities", ())),
        tuple(scope_data.get("open_questions_and_risks", ())),
    )
    estimates = tuple(Estimate(**item) for item in record.get("estimates", ()))
    return Proposal(record["proposal_id"], int(record["version"]), scope, estimates, float(record["total_likely_hours"]), record["pricing_assumption"], record.get("approval_status", "pending"), record.get("project_id", ""), record.get("approved_by"), record.get("approved_at"))


if __name__ == "__main__":
    main()
