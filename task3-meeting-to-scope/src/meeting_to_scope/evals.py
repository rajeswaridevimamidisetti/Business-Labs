from dataclasses import dataclass


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    transcript: str
    expected: str
    assertions: tuple[str, ...] = ()
    status: str = "pending"


def default_cases() -> tuple[EvaluationCase, ...]:
    cases = (
        ("Client: We need search and filters.", "explicit requirement", ("requirement_extracted",)),
        ("Client: Improve our website search.", "vague requirement", ("open_question",)),
        ("Client: We agreed that mobile users must have a usable experience.", "decision and commitment", ("source_traceable",)),
        ("Client: Delivery must be complete by March 30.", "deadline and constraint", ("deadline_preserved",)),
        ("Client: We still need to decide which filters are required.", "open question", ("not_confirmed",)),
        ("Client: We need checkout.\nClient: We do not need checkout.", "conflicting statements", ("conflict_review",)),
        ("Client: We need settings.", "Task 1 evidence available", ("citation_preserved",)),
        ("Client: We need an undocumented capability.", "Task 1 evidence insufficient", ("needs_clarification",)),
        ("Client: We need an unavailable integration.", "Task 1 service failure", ("failure_is_visible",)),
        ("Client: We need a member dashboard.", "source traceability", ("source_segment_id",)),
        ("Client: We need a searchable directory.", "acceptance criteria", ("testable_acceptance",)),
        ("Client: We need an API integration.", "estimate consistency", ("range_is_valid",)),
        ("Client: We need a proposal for search.", "proposal consistency", ("total_matches_tasks",)),
        ("Client: Add saved filters.", "follow-up added requirement", ("added_change",)),
        ("Client: Remove advanced export.", "follow-up removed requirement", ("removed_change",)),
        ("Client: Change search to include tags.", "follow-up modified requirement", ("modified_change",)),
        ("Client: Add an unrelated mobile app.", "potentially out-of-scope change", ("review_required",)),
        ("Client: Add a follow-up without a baseline.", "missing approved baseline", ("baseline_required",)),
        ("Client: We need search and filters.", "approval enforcement", ("send_blocked_until_approved",)),
        ("\n".join(f"[{index:02d}:00] Client: We need requirement {index}." for index in range(30)), "long transcript", ("all_segments_retained",)),
    )
    return tuple(EvaluationCase(f"task3-{index + 1:02d}", transcript, expected, assertions) for index, (transcript, expected, assertions) in enumerate(cases))
