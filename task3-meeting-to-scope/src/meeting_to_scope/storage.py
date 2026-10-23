"""Small local persistent proposal/baseline store for Task 3."""

from __future__ import annotations

from dataclasses import asdict
import json
import os
from pathlib import Path
from threading import RLock

from .models import Proposal


class ProposalStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._proposals: dict[str, dict] = {}
        self._lock = RLock()
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"proposal store is corrupt or unreadable: {self.path}") from exc
            if not isinstance(loaded, dict):
                raise RuntimeError(f"proposal store has invalid structure: {self.path}")
            if not all(isinstance(key, str) and isinstance(value, dict) for key, value in loaded.items()):
                raise RuntimeError(f"proposal store has invalid records: {self.path}")
            self._proposals = loaded

    def save(self, proposal: Proposal) -> None:
        if not proposal.proposal_id.strip() or proposal.version < 1:
            raise ValueError("proposal_id and a positive version are required")
        with self._lock:
            self._proposals[f"{proposal.proposal_id}:v{proposal.version}"] = asdict(proposal)
            self._flush()

    def get(self, proposal_id: str, version: int) -> dict | None:
        with self._lock:
            record = self._proposals.get(f"{proposal_id}:v{version}")
            return dict(record) if record is not None else None

    def latest(self, proposal_id: str) -> dict | None:
        with self._lock:
            records = [record for key, record in self._proposals.items() if key.startswith(f"{proposal_id}:v")]
            latest = max(records, key=lambda record: int(record.get("version", 0)), default=None)
            return dict(latest) if latest is not None else None

    def approved_baseline(self, project_id: str) -> dict | None:
        with self._lock:
            records = [
                record for record in self._proposals.values()
                if record.get("project_id") == project_id and record.get("approval_status") == "approved"
            ]
            baseline = max(records, key=lambda record: int(record.get("version", 0)), default=None)
            return dict(baseline) if baseline is not None else None

    def approve(self, proposal_id: str, version: int, reviewer: str) -> None:
        if not reviewer.strip():
            raise PermissionError("reviewer is required")
        with self._lock:
            record = self._proposals.get(f"{proposal_id}:v{version}")
            if record is None:
                raise KeyError("proposal version not found")
            if record.get("approval_status") == "approved":
                raise ValueError("proposal version is already approved")
            record["approval_status"] = "approved"
            record["approved_by"] = reviewer.strip()
            from datetime import datetime, timezone
            record["approved_at"] = datetime.now(timezone.utc).isoformat()
            self._flush()

    def _flush(self) -> None:
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        payload = json.dumps(self._proposals, indent=2, sort_keys=True)
        temporary.write_text(payload, encoding="utf-8")
        with temporary.open("r+", encoding="utf-8") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(self.path)
