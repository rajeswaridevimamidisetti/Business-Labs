"""Run the deterministic evaluation inventory without contacting Claude."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "shared" / "evaluations"


def load_task2_cases() -> list[dict[str, Any]]:
    command = [
        "node", "--import", "tsx", "--input-type=module", "-e",
        'import { defaultInboxEvaluationCases } from "./src/evals.ts"; console.log(JSON.stringify(defaultInboxEvaluationCases()));',
    ]
    completed = subprocess.run(command, cwd=ROOT / "task2-inbox-agent", check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def verify_case_inventory(task: str, cases: list[Any]) -> list[dict[str, Any]]:
    if len(cases) != 20:
        raise AssertionError(f"{task} has {len(cases)} cases, expected 20")
    ids = [case["id"] if isinstance(case, dict) else case.case_id for case in cases]
    if len(set(ids)) != 20:
        raise AssertionError(f"{task} case IDs are not distinct")
    records = []
    for case in cases:
        assertions = case.get("assertions", []) if isinstance(case, dict) else list(case.assertions)
        if not assertions:
            raise AssertionError(f"{task} case {case['id'] if isinstance(case, dict) else case.case_id} has no executable assertions")
        records.append({"case_id": case["id"] if isinstance(case, dict) else case.case_id, "status": "verified", "assertions": assertions})
    return records


def main() -> int:
    sys.path.insert(0, str(ROOT / "task1-knowledge-brain" / "src"))
    from knowledge_brain.evals import default_cases as task1_cases
    sys.path.pop(0)
    sys.path.insert(0, str(ROOT / "task3-meeting-to-scope" / "src"))
    from meeting_to_scope.evals import default_cases as task3_cases
    sys.path.pop(0)

    inventories = {
        "task1": verify_case_inventory("task1", list(task1_cases())),
        "task2": verify_case_inventory("task2", load_task2_cases()),
        "task3": verify_case_inventory("task3", list(task3_cases())),
    }
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    destination = RESULTS_DIR / f"offline-{timestamp}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({
        "evaluation_type": "offline_deterministic_inventory",
        "status": "executed",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider_called": False,
        "tasks": inventories,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Offline evaluation verified 60 cases; wrote {destination.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
