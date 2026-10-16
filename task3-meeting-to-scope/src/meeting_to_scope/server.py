"""Task 3 local HTTP smoke service using Task 1 only through its API."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .fixtures import synthetic_transcripts
from .models import EstimationAgent, ProductFeasibilityAgent, ProposalReviewAgent, ScopeAgent, TranscriptAnalyst, parse_transcript
from .task1_client import Task1ClientError, Task1HttpClient


class Handler(BaseHTTPRequestHandler):
    proposals: dict[str, object] = {}

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "task3-meeting-to-scope"})
            return
        if self.path == "/v1/transcripts":
            self._send(200, {"transcripts": [{"meeting_id": item.meeting_id, "date": item.date, "text": item.text, "follow_up_to": item.follow_up_to} for item in synthetic_transcripts()]})
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
                    self._send(404, {"error": "proposal_not_found"})
                    return
                approved = ProposalReviewAgent().approve(proposal, reviewer)
                self.proposals[proposal_id] = approved
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
                self.proposals[proposal.proposal_id] = proposal
                self._send(200, {"requirements": [asdict(item) for item in requirements], "feasibility": [asdict(item) for item in feasibility], "estimates": [asdict(item) for item in estimates], "proposal": asdict(proposal), "changes": None})
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


if __name__ == "__main__":
    main()
