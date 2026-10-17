"""Pending-by-default Task 1 evaluation cases and result writer."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import csv
import json
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    question: str
    expected_behavior: str
    required_citations: bool
    expected_status: str
    assertions: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvaluationResult:
    case_id: str
    configuration: str
    status: str = "pending"
    retrieval_score: float | None = None
    factual_score: float | None = None
    citation_score: float | None = None
    abstention_score: float | None = None
    latency_ms: float | None = None
    cost: float | None = None
    error: str | None = None


def default_cases() -> tuple[EvaluationCase, ...]:
    cases = (
        ("How do I update billing settings for my directory?", "documented billing settings", True, "answered", ("status_answered", "has_citation")),
        ("Where can I change the member signup form?", "documented signup form", True, "answered", ("status_answered", "has_citation")),
        ("How do I edit post settings?", "documented post settings", True, "answered", ("status_answered", "has_citation")),
        ("How do I configure a static page?", "documented static pages", True, "answered", ("status_answered", "has_citation")),
        ("Where are SEO settings managed?", "documented SEO settings", True, "answered", ("status_answered", "has_citation")),
        ("How do I change website builder settings?", "documented website builder", True, "answered", ("status_answered", "has_citation")),
        ("How do I update member profile fields?", "documented member fields", True, "answered", ("status_answered", "has_citation")),
        ("How do I configure directory search?", "documented directory search", True, "answered", ("status_answered", "has_citation")),
        ("How do I add a navigation page?", "documented navigation", True, "answered", ("status_answered", "has_citation")),
        ("What image reference explains the dashboard settings?", "image-backed documentation", True, "answered", ("status_answered", "has_citation")),
        ("Which settings control article visibility?", "documented visibility settings", True, "answered", ("status_answered", "has_citation")),
        ("How do I configure a member registration workflow?", "documented registration workflow", True, "answered", ("status_answered", "has_citation")),
        ("What is the current balance in my personal bank account?", "private unsupported financial data", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("What is my bank routing number?", "private unsupported financial data", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("Can you diagnose my personal medical condition?", "unsupported personal advice", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("What is the weather at my home right now?", "unsupported live personal context", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("Can you access my private customer records?", "private account access", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("Which undocumented feature will be released next month?", "unsupported roadmap question", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("How do I solve this unrelated website builder issue?", "irrelevant evidence rejection", False, "insufficient_evidence", ("abstains", "no_citation")),
        ("What should I do when the knowledge index is empty?", "empty index behavior", False, "insufficient_evidence", ("abstains", "no_citation")),
    )
    return tuple(EvaluationCase(f"task1-{index + 1:02d}", *case) for index, case in enumerate(cases))


def write_results(results: tuple[EvaluationResult, ...], directory: str | Path) -> None:
    destination = Path(directory)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "task1-results.json").write_text(json.dumps([asdict(item) for item in results], indent=2) + "\n", encoding="utf-8")
    with (destination / "task1-results.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(results[0]).keys()) if results else ["case_id"])
        writer.writeheader()
        writer.writerows(asdict(item) for item in results)
