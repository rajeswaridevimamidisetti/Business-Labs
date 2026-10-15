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
    categories = [
        ("direct", "Answer a direct documented fact", True, "answered"),
        ("multi", "Combine evidence from multiple articles", True, "answered"),
        ("screenshot", "Answer a question requiring an image reference", True, "answered"),
        ("unsupported", "Ask about an undocumented feature", False, "insufficient_evidence"),
        ("failure", "Handle unavailable retrieval", False, "service_unavailable"),
    ]
    return tuple(EvaluationCase(f"task1-{index:02d}", question, behavior, citations, status) for index in range(20) for question, behavior, citations, status in [categories[index % len(categories)]])


def write_results(results: tuple[EvaluationResult, ...], directory: str | Path) -> None:
    destination = Path(directory)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "task1-results.json").write_text(json.dumps([asdict(item) for item in results], indent=2) + "\n", encoding="utf-8")
    with (destination / "task1-results.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(results[0]).keys()) if results else ["case_id"])
        writer.writeheader()
        writer.writerows(asdict(item) for item in results)
