"""Start a safe deterministic three-service HTTP smoke environment."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib import request


if __name__ == "__main__":
    root = Path(__file__).parent
    required = ("task1-knowledge-brain", "task2-inbox-agent", "task3-meeting-to-scope")
    missing = [name for name in required if not (root / name).is_dir()]
    if missing:
        raise SystemExit(f"Missing task directories: {', '.join(missing)}")
    processes: list[subprocess.Popen[str]] = []
    environment = os.environ.copy()
    environment.update({"TASK1_MANIFEST_DB": "data/manifest.sqlite3", "TASK1_PORT": "8001", "TASK2_PORT": "8002", "TASK3_PORT": "8003", "TASK1_BASE_URL": "http://127.0.0.1:8001"})
    commands = [
        ([sys.executable, "-m", "knowledge_brain.server"], root / "task1-knowledge-brain", {"PYTHONPATH": "src"}),
        (["npm", "start"], root / "task2-inbox-agent", {}),
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
        task3_result = post("http://127.0.0.1:8003/v1/smoke/feasibility", {"question": "How do settings work?"})
        if task2_result.get("task1Status") != "answered" or task3_result.get("feasibility") != "verified":
            raise RuntimeError(f"downstream evidence smoke failed: {task2_result}, {task3_result}")
        print("E2E HTTP smoke passed: Task 2 and Task 3 obtained evidence through Task 1.")
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
