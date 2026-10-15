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
            self._proposals = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, proposal: Proposal) -> None:
        self._proposals[f"{proposal.proposal_id}:v{proposal.version}"] = asdict(proposal)
        self._flush()

    def get(self, proposal_id: str, version: int) -> dict | None:
        return self._proposals.get(f"{proposal_id}:v{version}")

    def approve(self, proposal_id: str, version: int, reviewer: str) -> None:
        record = self.get(proposal_id, version)
        if record is None:
            raise KeyError("proposal version not found")
        if not reviewer.strip():
            raise PermissionError("reviewer is required")
        record["approval_status"] = "approved"
        record["approved_by"] = reviewer
        self._flush()

    def _flush(self) -> None:
        self.path.write_text(json.dumps(self._proposals, indent=2), encoding="utf-8")
