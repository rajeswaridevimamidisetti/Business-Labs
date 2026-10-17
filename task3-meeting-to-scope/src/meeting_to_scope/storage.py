"""Small local persistent proposal/baseline store for Task 3."""

from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path

from .models import Proposal


class ProposalStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._proposals: dict[str, dict] = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"proposal store is corrupt or unreadable: {self.path}") from exc
            if not isinstance(loaded, dict):
                raise RuntimeError(f"proposal store has invalid structure: {self.path}")
            self._proposals = loaded

    def save(self, proposal: Proposal) -> None:
        self._proposals[f"{proposal.proposal_id}:v{proposal.version}"] = asdict(proposal)
        self._flush()

    def get(self, proposal_id: str, version: int) -> dict | None:
        return self._proposals.get(f"{proposal_id}:v{version}")

    def latest(self, proposal_id: str) -> dict | None:
        records = [record for key, record in self._proposals.items() if key.startswith(f"{proposal_id}:v")]
        return max(records, key=lambda record: int(record.get("version", 0)), default=None)

    def approved_baseline(self, project_id: str) -> dict | None:
        records = [
            record for record in self._proposals.values()
            if record.get("project_id") == project_id and record.get("approval_status") == "approved"
        ]
        return max(records, key=lambda record: int(record.get("version", 0)), default=None)

    def approve(self, proposal_id: str, version: int, reviewer: str) -> None:
        record = self.get(proposal_id, version)
        if record is None:
            raise KeyError("proposal version not found")
        if not reviewer.strip():
            raise PermissionError("reviewer is required")
        record["approval_status"] = "approved"
        record["approved_by"] = reviewer
        from datetime import datetime, timezone
        record["approved_at"] = datetime.now(timezone.utc).isoformat()
        self._flush()

    def _flush(self) -> None:
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(self._proposals, indent=2), encoding="utf-8")
        temporary.replace(self.path)
