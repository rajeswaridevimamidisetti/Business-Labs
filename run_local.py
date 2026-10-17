"""Start a safe deterministic three-service HTTP smoke environment."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib import request


if __name__ == "__main__":
    keep_alive = "--serve" in sys.argv[1:]
    root = Path(__file__).parent
    required = ("task1-knowledge-brain", "task2-inbox-agent", "task3-meeting-to-scope")
    missing = [name for name in required if not (root / name).is_dir()]
    if missing:
        raise SystemExit(f"Missing task directories: {', '.join(missing)}")
    processes: list[subprocess.Popen[str]] = []
    environment = os.environ.copy()
    environment.update({"TASK1_MANIFEST_DB": "data/manifest.sqlite3", "TASK1_PORT": "8001", "TASK2_PORT": "8002", "TASK3_PORT": "8003", "TASK1_BASE_URL": "http://127.0.0.1:8001"})
    node_command = "node.exe" if os.name == "nt" else "node"
    commands = [
        ([sys.executable, "-m", "knowledge_brain.server"], root / "task1-knowledge-brain", {"PYTHONPATH": "src"}),
        ([node_command, "--import", "tsx", "src/server.ts"], root / "task2-inbox-agent", {}),
        ([sys.executable, "-m", "meeting_to_scope.server"], root / "task3-meeting-to-scope", {"PYTHONPATH": "src"}),
    ]
    try:
        for command, cwd, extra in commands:
            child_env = environment | extra
            processes.append(subprocess.Popen(command, cwd=cwd, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                health = request.urlopen("http://127.0.0.1:8001/health", timeout=0.5)
                request.urlopen("http://127.0.0.1:8002/health", timeout=0.5)
                request.urlopen("http://127.0.0.1:8003/health", timeout=0.5)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("services did not become healthy")
        def post(url: str, payload: dict[str, str]) -> dict[str, object]:
            body = json.dumps(payload).encode()
            req = request.Request(url, data=body, headers={"content-type": "application/json", "x-request-id": "smoke-request"}, method="POST")
            with request.urlopen(req, timeout=3) as response:
                return json.loads(response.read().decode())
        task2_result = post("http://127.0.0.1:8002/v1/smoke/draft", {"emailId": "email-001"})
        task2_ui_result = post("http://127.0.0.1:8002/v1/drafts", {"emailId": "email-001"})
        task3_result = post("http://127.0.0.1:8003/v1/smoke/feasibility", {"question": "How do settings work?"})
        task3_scope = post(
            "http://127.0.0.1:8003/v1/scope",
            {"meeting_id": "smoke-meeting", "project_id": "smoke-project", "date": "2026-01-01", "transcript": "[00:01] Client: We need settings."},
        )
        def task2_is_safe(result: dict[str, object]) -> bool:
            status = result.get("task1Status")
            draft = result.get("draft")
            if status == "answered":
                return isinstance(draft, dict) and bool(draft.get("evidence"))
            if status == "insufficient_evidence":
                return (
                    isinstance(draft, dict)
                    and not draft.get("evidence")
                    and draft.get("humanApprovalRequired") is True
                )
            return False

        if (
            not task2_is_safe(task2_result)
            or not task2_is_safe(task2_ui_result)
            or task3_result.get("feasibility") != "verified"
            or not task3_scope.get("proposal")
        ):
            raise RuntimeError(f"downstream evidence smoke failed: {task2_result}, {task2_ui_result}, {task3_result}, {task3_scope}")
        print("E2E HTTP smoke passed: Task 2 and Task 3 used Task 1 safely, including UI routes.")
        if keep_alive:
            print("Services are running. Press Ctrl+C to stop them.")
            while True:
                time.sleep(1)
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
