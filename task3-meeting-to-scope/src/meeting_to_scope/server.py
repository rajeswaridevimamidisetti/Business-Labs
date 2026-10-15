"""Task 3 local HTTP smoke service using Task 1 only through its API."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .task1_client import Task1ClientError, Task1HttpClient


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "task3-meeting-to-scope"})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/v1/smoke/feasibility":
            self._send(404, {"error": "not_found"})
            return
        length = int(self.headers.get("content-length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = payload["question"]
            result = Task1HttpClient(os.getenv("TASK1_BASE_URL", "http://127.0.0.1:8001")).query(question, self.headers.get("x-request-id"))
            self._send(200, {"feasibility": "verified" if result.get("status") == "answered" and result.get("sources") else "unverified", "evidence": result.get("sources", []), "task1_status": result.get("status")})
        except (KeyError, json.JSONDecodeError):
            self._send(400, {"error": "invalid_request"})
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


def main() -> None:
    host = os.getenv("TASK3_HOST", "127.0.0.1")
    port = int(os.getenv("TASK3_PORT", "8003"))
    with ThreadingHTTPServer((host, port), Handler) as server:
        print(f"Task 3 API listening on http://{host}:{port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
