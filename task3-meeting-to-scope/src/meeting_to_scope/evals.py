from dataclasses import dataclass


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    expected: str
    status: str = "pending"


def default_cases() -> tuple[EvaluationCase, ...]:
    topics = ("explicit requirement", "vague requirement", "missing date", "contradiction", "source reference", "configuration", "custom", "Task 1 failure", "acceptance criteria", "estimate uncertainty")
    return tuple(EvaluationCase(f"task3-{index:02d}", topics[index % len(topics)]) for index in range(20))
