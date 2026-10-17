"""Run live Claude evaluations against the three local task interfaces.

This module is deliberately separate from the application services and their
deterministic tests. It never fabricates a model response when a service or
provider call fails.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Callable, Iterable
from urllib import error, request
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "shared" / "evaluations"


@dataclass(frozen=True)
class Case:
    case_id: str
    task: str
    prompt: str
    expected: str
    metadata: dict[str, Any]


@dataclass
class Result:
    case_id: str
    task: str
    model: str
    timestamp: str
    output: Any = None
    score: dict[str, Any] | None = None
    token_usage: dict[str, int] | None = None
    estimated_cost_usd: float | None = None
    latency_ms: float | None = None
    error: str | None = None
    provider_called: bool = False
    status: str = "not_executed"


class EvaluationError(RuntimeError):
    pass


def _load_python_cases(module_name: str, package_root: Path, task: str) -> list[Case]:
    sys.path.insert(0, str(package_root / "src"))
    try:
        module = __import__(module_name, fromlist=["default_cases"])
        source_cases = module.default_cases()
    finally:
        sys.path.pop(0)
    cases: list[Case] = []
    for source in source_cases:
        if task == "task1":
            prompt = source.question
            expected = source.expected_behavior
            metadata = {"required_citations": source.required_citations, "expected_status": source.expected_status}
        else:
            prompt = source.transcript
            expected = source.expected
            metadata = {"assertions": list(source.assertions)}
        cases.append(Case(source.case_id, task, prompt, expected, metadata))
    return cases


def load_task1_cases() -> list[Case]:
    return _load_python_cases("knowledge_brain.evals", ROOT / "task1-knowledge-brain", "task1")


def load_task3_cases() -> list[Case]:
    return _load_python_cases("meeting_to_scope.evals", ROOT / "task3-meeting-to-scope", "task3")


def load_task2_cases() -> list[Case]:
    command = [
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        (
            'import { defaultInboxEvaluationCases } from "./src/evals.ts"; '
            'console.log(JSON.stringify(defaultInboxEvaluationCases()));'
        ),
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT / "task2-inbox-agent",
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise EvaluationError(f"could not load Task 2 cases through its TypeScript module: {detail.strip()}") from exc
    try:
        source_cases = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise EvaluationError("Task 2 case loader returned invalid JSON") from exc
    return [
        Case(
            source["id"],
            "task2",
            f"Evaluate the inbox workflow for the {source['category']} email.",
            source["expected"],
            {"category": source["category"], "held_out": source["heldOut"]},
        )
        for source in source_cases
    ]


def load_cases() -> dict[str, list[Case]]:
    cases = {"task1": load_task1_cases(), "task2": load_task2_cases(), "task3": load_task3_cases()}
    for task, task_cases in cases.items():
        if len(task_cases) != 20:
            raise EvaluationError(f"{task} provides {len(task_cases)} cases; refusing to claim 20")
    return cases


def _json_request(base_url: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json", "X-Request-ID": f"live-eval-{uuid4().hex}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = request.Request(f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method="POST" if data else "GET")
    try:
        with request.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (error.URLError, error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"interface request failed: {exc}") from exc


def fetch_application_output(case: Case, urls: dict[str, str], index: int) -> Any:
    if case.task == "task1":
        return _json_request(urls["task1"], "/query", {"question": case.prompt})
    if case.task == "task2":
        emails = _json_request(urls["task2"], "/v1/emails").get("emails", [])
        if index >= len(emails):
            raise EvaluationError(f"Task 2 has no email for case index {index}")
        return _json_request(urls["task2"], "/v1/drafts", {"emailId": emails[index]["id"]})
    transcripts = _json_request(urls["task3"], "/v1/transcripts").get("transcripts", [])
    if not transcripts:
        raise EvaluationError("Task 3 returned no transcripts")
    transcript = transcripts[index % len(transcripts)]
    return _json_request(
        urls["task3"],
        "/v1/scope",
        {
            "meeting_id": transcript["meeting_id"],
            "project_id": transcript.get("project_id", "live-eval-project"),
            "date": transcript["date"],
            "transcript": transcript["text"],
            "follow_up_to": transcript.get("follow_up_to"),
        },
    )


def _scoring_criteria(case: Case) -> str:
    if case.task == "task1":
        return (
            "Score answer_correctness, citation_support, and abstention_behavior from 0 to 1. "
            "A citation score is 1 only when sources support the answer. For expected unsupported "
            "or unavailable behavior, abstention_behavior is 1 only when the response does not invent an answer."
        )
    if case.task == "task2":
        return (
            "Score workflow_quality, evidence_grounding, and safety_review from 0 to 1. "
            "Reward a draft grounded in returned Task 1 evidence and human review for risky or unsupported cases."
        )
    return (
        "Score extraction_quality, feasibility_traceability, scope_estimate_quality, and approval_safety "
        "from 0 to 1. Reward source-linked requirements, explicit uncertainty, and enforcement of approval before sending."
    )


def judge_with_claude(client: Any, case: Case, application_output: Any, model: str) -> tuple[dict[str, Any], str, dict[str, int]]:
    system = (
        "You are an evaluation judge. Return JSON only with keys: scores (object containing the requested "
        "criterion names and numeric 0..1 values), overall_score (numeric 0..1), rationale (short string), "
        "and human_review_required (boolean). Automated scores are provisional and must not be described as human-reviewed."
    )
    prompt = (
        f"Task: {case.task}\nCase: {case.case_id}\nExpected behavior: {case.expected}\n"
        f"Case prompt: {case.prompt}\nScoring criteria: {_scoring_criteria(case)}\n"
        f"Application response JSON:\n{json.dumps(application_output, ensure_ascii=False)}"
    )
    try:
        response = client.messages.create(
            model=model,
            max_tokens=600,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:
        raise EvaluationError(f"Claude provider request failed: {exc}") from exc
    text = "".join(getattr(block, "text", "") for block in response.content).strip()
    try:
        judgment = json.loads(text)
    except json.JSONDecodeError as exc:
        raise EvaluationError("Claude returned a non-JSON evaluation") from exc
    if not isinstance(judgment, dict) or not isinstance(judgment.get("scores"), dict):
        raise EvaluationError("Claude evaluation JSON has an invalid shape")
    usage = getattr(response, "usage", None)
    token_usage = {
        "input_tokens": int(getattr(usage, "input_tokens", 0)),
        "output_tokens": int(getattr(usage, "output_tokens", 0)),
    }
    return judgment, text, token_usage


def _cost(token_usage: dict[str, int]) -> float | None:
    try:
        input_rate = float(os.environ["CLAUDE_INPUT_USD_PER_MTOK"])
        output_rate = float(os.environ["CLAUDE_OUTPUT_USD_PER_MTOK"])
    except (KeyError, ValueError):
        return None
    return (token_usage["input_tokens"] * input_rate + token_usage["output_tokens"] * output_rate) / 1_000_000


def run_evaluation(
    cases: dict[str, list[Case]],
    client_factory: Callable[[str], Any],
    model: str,
    urls: dict[str, str],
) -> Path:
    api_key = os.getenv("CLAUDE_API_KEY", "").strip()
    if not api_key or api_key == "replace-with-local-secret":
        raise EvaluationError("CLAUDE_API_KEY is missing or still a placeholder; no API calls were made")
    client = client_factory(api_key)
    results: list[Result] = []
    for task, task_cases in cases.items():
        for index, case in enumerate(task_cases):
            started = time.perf_counter()
            result = Result(case.case_id, task, model, datetime.now(timezone.utc).isoformat())
            try:
                application_output = fetch_application_output(case, urls, index)
                result.output = application_output
                judgment, raw_judgment, usage = judge_with_claude(client, case, application_output, model)
                result.score = {**judgment, "raw_response": raw_judgment, "provisional": True}
                result.token_usage = usage
                result.estimated_cost_usd = _cost(usage)
                result.provider_called = True
                result.status = "executed"
            except EvaluationError as exc:
                result.error = str(exc)
                result.status = "failed"
            finally:
                result.latency_ms = round((time.perf_counter() - started) * 1000, 2)
            results.append(result)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = RESULTS_DIR / f"live-claude-{timestamp}.json"
    destination.write_text(json.dumps({"run_timestamp": timestamp, "model": model, "results": [asdict(item) for item in results]}, indent=2) + "\n", encoding="utf-8")
    return destination


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the separate live Claude evaluation.")
    parser.add_argument("--dry-run", action="store_true", help="Validate case inventory and configuration without calls.")
    parser.add_argument("--model", default=os.getenv("CLAUDE_MODEL", ""), help="Claude model; defaults to CLAUDE_MODEL.")
    parser.add_argument("--task1-url", default=os.getenv("TASK1_BASE_URL", "http://127.0.0.1:8001"))
    parser.add_argument("--task2-url", default=os.getenv("TASK2_BASE_URL", "http://127.0.0.1:8002"))
    parser.add_argument("--task3-url", default=os.getenv("TASK3_BASE_URL", "http://127.0.0.1:8003"))
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        cases = load_cases()
        if args.dry_run:
            print(f"Dry run: {sum(len(items) for items in cases.values())} cases loaded (20 per task). No API calls made.")
            return 0
        if not os.getenv("CLAUDE_API_KEY", "").strip() or os.getenv("CLAUDE_API_KEY", "").strip() == "replace-with-local-secret":
            raise EvaluationError("CLAUDE_API_KEY is missing or still a placeholder; no API calls were made")
        if not args.model or args.model == "replace-with-approved-claude-model":
            raise EvaluationError("CLAUDE_MODEL is missing or still a placeholder")
        try:
            from anthropic import Anthropic
        except ImportError as exc:
            raise EvaluationError("Anthropic SDK is missing; install evaluator/requirements.txt") from exc
        destination = run_evaluation(
            cases,
            lambda api_key: Anthropic(api_key=api_key),
            args.model,
            {"task1": args.task1_url, "task2": args.task2_url, "task3": args.task3_url},
        )
        print(f"Evaluation recorded: {destination}")
        return 0
    except EvaluationError as exc:
        print(f"Live evaluation not run: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
