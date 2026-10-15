"""Versioned, review-gated expert answers for Task 1."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import sqlite3
from pathlib import Path
from uuid import uuid4

from .api import Escalation, SourceCitation


@dataclass(frozen=True)
class ExpertAnswer:
    answer_id: str
    escalation_id: str
    answer: str
    evidence: tuple[SourceCitation, ...]
    applicability: str
    reviewer: str
    version: int
    expires_at: str | None
    approved: bool


class VersionedEscalationStore:
    def __init__(self, database_path: str | Path, authorized_reviewers: set[str]) -> None:
        self.database_path = str(database_path)
        self.authorized_reviewers = set(authorized_reviewers)
        Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS escalations (
                escalation_id TEXT PRIMARY KEY, question TEXT NOT NULL, reason TEXT NOT NULL,
                evidence_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                resolved_at TEXT, reviewer_answer TEXT
            );
            CREATE TABLE IF NOT EXISTS expert_answers (
                answer_id TEXT PRIMARY KEY, escalation_id TEXT NOT NULL, answer TEXT NOT NULL,
                evidence_json TEXT NOT NULL, applicability TEXT NOT NULL, reviewer TEXT NOT NULL,
                version INTEGER NOT NULL, expires_at TEXT, approved INTEGER NOT NULL
            );
            """
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def create(self, question: str, reason: str, evidence: tuple[SourceCitation, ...], request_id: str) -> Escalation:
        import json

        record = Escalation(f"esc_{uuid4().hex}", question, reason, evidence, "open", _now())
        self.connection.execute("INSERT INTO escalations VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (record.escalation_id, question, reason, json.dumps([_citation(item) for item in evidence]), record.status, record.created_at, None, None))
        self.connection.commit()
        return record

    def resolve(self, escalation_id: str, answer: str, reviewer: str, request_id: str) -> Escalation | None:
        if reviewer not in self.authorized_reviewers:
            raise PermissionError("reviewer is not authorized")
        row = self.connection.execute("SELECT * FROM escalations WHERE escalation_id = ?", (escalation_id,)).fetchone()
        if row is None:
            return None
        resolved_at = _now()
        self.connection.execute("UPDATE escalations SET status = 'resolved', resolved_at = ?, reviewer_answer = ? WHERE escalation_id = ?", (resolved_at, answer, escalation_id))
        self.connection.commit()
        return Escalation(escalation_id, row["question"], row["reason"], _evidence(row["evidence_json"]), "resolved", row["created_at"], resolved_at, answer)

    def approve_expert_answer(self, escalation_id: str, answer: str, evidence: tuple[SourceCitation, ...], applicability: str, reviewer: str, expires_at: str | None = None) -> ExpertAnswer:
        if reviewer not in self.authorized_reviewers:
            raise PermissionError("reviewer is not authorized")
        row = self.connection.execute("SELECT COALESCE(MAX(version), 0) AS version FROM expert_answers WHERE escalation_id = ?", (escalation_id,)).fetchone()
        version = int(row["version"]) + 1
        answer_record = ExpertAnswer(f"ans_{uuid4().hex}", escalation_id, answer, evidence, applicability, reviewer, version, expires_at, True)
        import json
        self.connection.execute("INSERT INTO expert_answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (answer_record.answer_id, escalation_id, answer, json.dumps([_citation(item) for item in evidence]), applicability, reviewer, version, expires_at, 1))
        self.connection.commit()
        return answer_record

    def retrievable_answers(self, applicability: str, now: str | None = None) -> tuple[ExpertAnswer, ...]:
        import json
        now = now or _now()
        rows = self.connection.execute("SELECT * FROM expert_answers WHERE approved = 1 AND applicability = ? AND (expires_at IS NULL OR expires_at > ?)", (applicability, now)).fetchall()
        return tuple(ExpertAnswer(row["answer_id"], row["escalation_id"], row["answer"], _evidence(row["evidence_json"]), row["applicability"], row["reviewer"], row["version"], row["expires_at"], bool(row["approved"])) for row in rows)


def _citation(item: SourceCitation) -> dict[str, str | None]:
    return {"title": item.title, "url": item.url, "section": item.section, "chunk_id": item.chunk_id}


def _evidence(value: str) -> tuple[SourceCitation, ...]:
    import json
    return tuple(SourceCitation(item["title"], item["url"], item.get("section"), item.get("chunk_id")) for item in json.loads(value))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
