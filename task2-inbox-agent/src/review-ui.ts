import { Draft, IncomingEmail } from "./schemas.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

export function renderReviewPage(email: IncomingEmail, draft: Draft): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inbox Review</title></head><body><main><h1>Inbox Review</h1><section><h2>${escapeHtml(email.subject)}</h2><p>${escapeHtml(email.body)}</p></section><section><p>Category: ${escapeHtml(draft.classification.category)}</p><p>Risk: ${escapeHtml(draft.risk)}</p><p>Approval required: ${draft.humanApprovalRequired ? "yes" : "no"}</p><h2>Draft</h2><textarea>${escapeHtml(draft.suggestedReply)}</textarea><p>Evidence: ${draft.evidenceStatus ?? (draft.evidence.length ? "supported" : "insufficient")} · ${draft.evidence.length} source(s)</p><button data-action="approve">Approve (no email delivery)</button><button data-action="edit">Save edit</button><button data-action="reject">Reject</button><button data-action="expert_assistance">Request expert assistance</button></section></main></body></html>`;
}
