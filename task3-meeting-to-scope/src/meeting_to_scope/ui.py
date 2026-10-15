"""Small dependency-free scope review page renderer."""

from .models import ChangeReport, Proposal, Requirement


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def render_scope_page(proposal: Proposal, requirements: tuple[Requirement, ...], changes: ChangeReport | None = None) -> str:
    rows = "".join(f"<li><strong>{_escape(item.requirement_id)}</strong>: {_escape(item.description)} ({_escape(item.status)})</li>" for item in requirements)
    change_html = "" if changes is None else f"<h2>Changes</h2><p>Added: {len(changes.added)}; Removed: {len(changes.removed)}; Modified: {len(changes.modified)}; Unchanged: {len(changes.unchanged)}</p>"
    return f"<!doctype html><html><head><meta charset='utf-8'><title>Scope Builder</title></head><body><main><h1>Scope Builder</h1><p>Proposal status: {_escape(proposal.approval_status)}</p><p>Likely hours: {proposal.total_likely_hours}</p><h2>Requirements</h2><ul>{rows}</ul>{change_html}<button data-action='approve'>Approve proposal</button><button data-action='reject'>Reject proposal</button></main></body></html>"
