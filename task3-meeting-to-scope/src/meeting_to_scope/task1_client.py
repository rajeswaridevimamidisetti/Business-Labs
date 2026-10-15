"""Task 3's HTTP-only client for the public Task 1 API."""

from __future__ import annotations

import json
from typing import Any
from urllib import error, request
from uuid import uuid4


class Task1ClientError(RuntimeError):
    pass


class Task1HttpClient:
    def __init__(self, base_url: str, timeout_seconds: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def query(self, question: str, request_id: str | None = None) -> dict[str, Any]:
        identifier = request_id or f"task3-{uuid4().hex}"
        payload = json.dumps({"question": question}).encode("utf-8")
        req = request.Request(f"{self.base_url}/query", data=payload, headers={"Content-Type": "application/json", "X-Request-ID": identifier}, method="POST")
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (TimeoutError, error.URLError) as exc:
            raise Task1ClientError("Task 1 unavailable") from exc
        except (ValueError, json.JSONDecodeError) as exc:
            raise Task1ClientError("Task 1 returned invalid JSON") from exc
        if not isinstance(body, dict) or not isinstance(body.get("status"), str) or not isinstance(body.get("sources"), list):
            raise Task1ClientError("Task 1 response violated the public contract")
        return body
