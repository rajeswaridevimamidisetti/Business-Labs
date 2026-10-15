"""Validated Task 3 records and staged workflow responsibilities."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from pathlib import Path
import re
from typing import Any, Protocol


@dataclass(frozen=True)
class TranscriptSegment:
    segment_id: str
    speaker: str
    timestamp: str | None
    text: str


@dataclass(frozen=True)
class Transcript:
    meeting_id: str
    project_id: str
    date: str
    text: str
    segments: tuple[TranscriptSegment, ...]
    follow_up_to: str | None = None
    synthetic: bool = True


@dataclass(frozen=True)
class Requirement:
    requirement_id: str
    description: str
    source_segment_id: str
    source_passage: str
    status: str
    priority: str
    explicit: bool
    acceptance_criteria: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    existing_solution_status: str = "unverified"
    estimate_status: str = "pending"


@dataclass(frozen=True)
class Feasibility:
    requirement_id: str
    classification: str
    evidence: tuple[dict[str, Any], ...]
    reason: str | None = None
    verified: bool = True


@dataclass(frozen=True)
class Estimate:
    requirement_id: str
    task: str
    low_hours: float
    likely_hours: float
    high_hours: float
    rationale: str
    assumptions: tuple[str, ...]
    dependencies: tuple[str, ...]
    human_review_required: bool


@dataclass(frozen=True)
class ScopeDocument:
    project_objective: str
    current_problem: str
    agreed_requirements: tuple[Requirement, ...]
    proposed_solution: str
    deliverables: tuple[str, ...]
    exclusions: tuple[str, ...]
    assumptions: tuple[str, ...]
    dependencies: tuple[str, ...]
    acceptance_criteria: tuple[str, ...]
    client_responsibilities: tuple[str, ...]
    open_questions_and_risks: tuple[str, ...]


@dataclass(frozen=True)
class Proposal:
    proposal_id: str
    version: int
    scope: ScopeDocument
    estimates: tuple[Estimate, ...]
    total_likely_hours: float
    pricing_assumption: str
    approval_status: str = "pending"


@dataclass(frozen=True)
class ChangeReport:
    added: tuple[str, ...]
    removed: tuple[str, ...]
    modified: tuple[str, ...]
    unchanged: tuple[str, ...]
    conflicting: tuple[str, ...]
    unresolved: tuple[str, ...]
    out_of_scope: tuple[str, ...]


class Task1KnowledgeClient(Protocol):
    def query(self, question: str, request_id: str) -> dict[str, Any]: ...


def parse_transcript(meeting_id: str, project_id: str, date: str, text: str, follow_up_to: str | None = None) -> Transcript:
    segments: list[TranscriptSegment] = []
    pattern = re.compile(r"^\s*(?:\[(?P<time>[^]]+)\]\s*)?(?P<speaker>[^:]+):\s*(?P<text>.+)$")
    for index, line in enumerate(text.splitlines(), 1):
        match = pattern.match(line)
        if match:
            segments.append(TranscriptSegment(f"{meeting_id}-seg-{index}", match.group("speaker").strip(), match.group("time"), match.group("text").strip()))
    if not segments:
        segments = [TranscriptSegment(f"{meeting_id}-seg-1", "Unknown", None, text.strip())]
    return Transcript(meeting_id, project_id, date, text, tuple(segments), follow_up_to)


class TranscriptAnalyst:
    """Extracts traceable facts without promoting inference to commitment."""

    def analyze(self, transcript: Transcript) -> tuple[Requirement, ...]:
        requirements: list[Requirement] = []
        for segment in transcript.segments:
            sentences = re.split(r"(?<=[.!?])\s+", segment.text)
            for sentence in sentences:
                if not re.search(r"\b(need|want|require|must|should|add|remove|change)\b", sentence, re.I):
                    continue
                explicit = bool(re.search(r"\b(need|require|must)\b", sentence, re.I))
                normalized = re.sub(r"\s+", " ", sentence).strip()
                requirement_id = "req-" + hashlib.sha256(f"{transcript.project_id}:{normalized.lower()}".encode()).hexdigest()[:12]
                status = "confirmed" if explicit else "unclear"
                requirements.append(Requirement(requirement_id, normalized, segment.segment_id, normalized, status, "normal", explicit))
        deduplicated: dict[str, Requirement] = {}
        for requirement in requirements:
            deduplicated.setdefault(requirement.requirement_id, requirement)
        return tuple(deduplicated.values())


class ProductFeasibilityAgent:
    def check(self, requirements: tuple[Requirement, ...], client: Task1KnowledgeClient) -> tuple[Feasibility, ...]:
        results: list[Feasibility] = []
        for requirement in requirements:
            try:
                response = client.query(requirement.description, f"feas-{requirement.requirement_id}")
            except Exception:
                results.append(Feasibility(requirement.requirement_id, "needs clarification", (), "Task 1 unavailable; absence of search results is not proof of absence", False))
                continue
            sources = tuple(response.get("sources", []))
            status = response.get("status")
            if status != "answered" or not sources:
                classification = "needs clarification"
                reason = "Task 1 evidence is insufficient; absence of search results is not proof of absence"
            elif any(word in str(response.get("answer", "")).lower() for word in ("custom", "api integration", "development")):
                classification, reason = "potential custom development", None
            elif "limitation" in str(response.get("answer", "")).lower():
                classification, reason = "existing feature with limitation", None
            else:
                classification, reason = "existing configuration", None
            results.append(Feasibility(requirement.requirement_id, classification, sources, reason, True))
        return tuple(results)


class ScopeAgent:
    def build(self, requirements: tuple[Requirement, ...], feasibility: tuple[Feasibility, ...]) -> ScopeDocument:
        unverified = tuple(item.requirement_id for item in feasibility if not item.verified or item.classification == "needs clarification")
        return ScopeDocument(
            "Deliver the agreed client workflow improvements.",
            "The current workflow does not fully support the requested outcome.",
            requirements,
            "Implement only requirements with traceable evidence and clarify unverified items before commitment.",
            tuple(item.description for item in requirements if item.status == "confirmed"),
            ("Unverified integrations and requirements without approval",),
            ("Client supplies access, content, credentials and acceptance decisions",),
            tuple(unverified),
            tuple(f"{item.requirement_id}: confirm observable acceptance behavior" for item in requirements),
            ("Provide timely feedback and test data",),
            tuple(f"Clarify feasibility for {item}" for item in unverified),
        )


class EstimationAgent:
    def estimate(self, scope: ScopeDocument) -> tuple[Estimate, ...]:
        estimates: list[Estimate] = []
        for requirement in scope.agreed_requirements:
            uncertain = requirement.requirement_id in scope.dependencies
            estimates.append(Estimate(requirement.requirement_id, requirement.description, 4, 8, 16, "Small initial work-package estimate; validate after clarification.", ("Requirements remain stable",), scope.dependencies, uncertain))
        return tuple(estimates)


class ProposalReviewAgent:
    def create(self, proposal_id: str, scope: ScopeDocument, estimates: tuple[Estimate, ...], version: int = 1) -> Proposal:
        return Proposal(proposal_id, version, scope, estimates, sum(item.likely_hours for item in estimates), "Pricing is intentionally configurable and is not an approved commercial quote.")

    def approve(self, proposal: Proposal, reviewer: str) -> Proposal:
        if not reviewer.strip():
            raise PermissionError("reviewer is required")
        return Proposal(proposal.proposal_id, proposal.version, proposal.scope, proposal.estimates, proposal.total_likely_hours, proposal.pricing_assumption, "approved")

    def send(self, proposal: Proposal) -> str:
        if proposal.approval_status != "approved":
            raise PermissionError("proposal must be approved before it can be sent")
        return f"sent:{proposal.proposal_id}:v{proposal.version}"

    def compare(self, baseline: Proposal, revised: Proposal) -> ChangeReport:
        before = {item.requirement_id: item.description for item in baseline.scope.agreed_requirements}
        after = {item.requirement_id: item.description for item in revised.scope.agreed_requirements}
        added = tuple(sorted(set(after) - set(before)))
        removed = tuple(sorted(set(before) - set(after)))
        modified = tuple(sorted(key for key in set(before) & set(after) if before[key] != after[key]))
        unchanged = tuple(sorted(key for key in set(before) & set(after) if before[key] == after[key]))
        return ChangeReport(added, removed, modified, unchanged, (), tuple(revised.scope.dependencies), added)
