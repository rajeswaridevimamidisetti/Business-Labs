import { FormEvent, useEffect, useState } from "react";

type Citation = { title: string; url: string; section?: string | null };
type Email = { id: string; from: string; subject: string; body: string; expectedCategory: string; expectedRisk: string; heldOut: boolean };
type Draft = { emailId: string; classification: { category: string; urgency: string; risk: string }; suggestedReply: string; evidence: Citation[]; evidenceStatus?: string; humanApprovalRequired: boolean; nextAction: string };
type ReviewStatus = "pending" | "approved" | "edited" | "rejected" | "expert_assistance";
type ScopeResult = { requirements: Array<{ requirement_id: string; description: string; source_segment_id: string; status: string }>; feasibility: Array<{ requirement_id: string; classification: string; evidence: Citation[]; reason?: string }>; estimates: Array<{ requirement_id: string; task: string; low_hours: number; likely_hours: number; high_hours: number }>; proposal: { proposal_id: string; version: number; approval_status: string; total_likely_hours: number; pricing_assumption: string }; changes: { added: string[]; removed: string[]; modified: string[]; unchanged: string[] } | null };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { "content-type": "application/json", ...(options?.headers ?? {}) }, ...options });
  const body = await response.text();
  let payload: (T & { error?: string; message?: string }) | undefined;
  if (body.trim()) {
    try {
      payload = JSON.parse(body) as T & { error?: string; message?: string };
    } catch {
      throw new Error(`Service returned invalid JSON (${response.status}).`);
    }
  }
  if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `Request failed (${response.status})`);
  if (!payload) throw new Error(`Service returned an empty response (${response.status}).`);
  return payload;
}

function Status({ message, error }: { message?: string; error?: string }) {
  if (!message && !error) return null;
  return <p className={error ? "status error" : "status"}>{error ?? message}</p>;
}

function KnowledgeBrain() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<{ answer: string | null; status: string; sources: Citation[]; human_help_needed: boolean; retrieval_trace: string[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim().length < 3) { setError("Enter a question with at least 3 characters."); return; }
    setBusy(true); setError("");
    try { setResult(await api("/api/task1/query", { method: "POST", body: JSON.stringify({ question }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : "Knowledge query failed."); } finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="section-heading"><span className="eyebrow">01 · Knowledge Brain</span><h2>Grounded answers, visible evidence</h2><p>Ask the configured Knowledge Brain. Answers and abstentions come directly from Task 1.</p></div>
    <form onSubmit={submit} className="stack"><label htmlFor="question">Question</label><textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="How do settings work?" rows={4} /><button disabled={busy}>{busy ? "Searching…" : "Ask Knowledge Brain"}</button></form>
    <Status error={error} />
    {result && <div className="result-card"><div className="result-meta"><strong>{result.status.replace(/_/g, " ")}</strong><span>{result.human_help_needed ? "Human help needed" : result.sources.length ? "Retrieved KB evidence" : "No evidence"}</span></div><p className="answer">{result.answer ?? "No grounded answer was returned."}</p><h3>Sources</h3>{result.sources.length ? <ul className="source-list">{result.sources.map((source) => <li key={`${source.url}-${source.title}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{source.section && <small>{source.section}</small>}</li>)}</ul> : <p className="muted">No citations returned. Treat this response as an abstention.</p>}<small>Trace: {result.retrieval_trace.join(" · ") || "not provided"}</small></div>}
  </section>;
}

function InboxAgent() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("pending");
  useEffect(() => { api<{ emails: Email[] }>("/api/task2/v1/emails").then((payload) => { setEmails(payload.emails); setSelected(payload.emails[0]?.id ?? ""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load emails.")); }, []);
  async function createDraft() { if (!selected) return; setBusy(true); setError(""); setMessage(""); try { const payload = await api<{ draft: Draft; reviewStatus: ReviewStatus }>("/api/task2/v1/drafts", { method: "POST", body: JSON.stringify({ emailId: selected }) }); setDraft(payload.draft); setReply(payload.draft.suggestedReply); setReviewStatus(payload.reviewStatus); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create draft."); } finally { setBusy(false); } }
  async function review(action: "approve" | "save" | "edit" | "reject" | "expert_assistance") {
    if (!draft) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ reviewStatus: ReviewStatus }>("/api/task2/v1/reviews", {
        method: "POST",
        body: JSON.stringify({
          emailId: draft.emailId,
          action,
          finalContent: action === "save" || action === "edit" || action === "reject" ? reply : undefined,
          reason: action === "expert_assistance" ? "Requested from browser review console" : undefined,
        }),
      });
      setReviewStatus(result.reviewStatus);
      setMessage(action === "save" ? "Draft saved. Review remains open." : `Review action recorded: ${action.replace("_", " ")}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review action failed.");
    } finally { setBusy(false); }
  }
  const reviewFinalized = reviewStatus !== "pending";
  const email = emails.find((item) => item.id === selected);
  return <section className="panel">
    <div className="section-heading"><span className="eyebrow">02 · Inbox Agent</span><h2>Review before anything is sent</h2><p>Choose a backend-provided synthetic email, generate an evidence-grounded draft, then record a review action.</p></div>
    <div className="split"><div className="stack"><label htmlFor="email">Email</label><select id="email" value={selected} onChange={(event) => { setSelected(event.target.value); setDraft(undefined); setReviewStatus("pending"); setMessage(""); setError(""); }}>{emails.map((item) => <option key={item.id} value={item.id}>{item.subject}</option>)}</select>{email && <article className="email-card"><small>{email.from} · {email.id}</small><h3>{email.subject}</h3><p>{email.body}</p><div className="tags"><span>{email.expectedCategory}</span><span>{email.expectedRisk} risk</span></div></article>}<button onClick={createDraft} disabled={busy || !selected}>{busy ? "Working…" : "Generate draft"}</button></div>{draft && <div className="draft-card"><div className="result-meta"><strong>{draft.classification.category}</strong><span>{draft.classification.risk} risk · review {reviewStatus}</span></div><label htmlFor="reply">Draft reply</label><textarea id="reply" value={reply} onChange={(event) => setReply(event.target.value)} rows={9} disabled={reviewFinalized} /><p className="muted">{draft.nextAction} · evidence {draft.evidenceStatus ?? (draft.evidence.length ? "supported" : "insufficient")} · {draft.evidence.length} evidence item(s)</p><div className="actions"><button onClick={() => review("approve")} disabled={busy || reviewFinalized}>Approve</button><button onClick={() => review("save")} disabled={busy || reviewFinalized}>Save edit</button><button className="quiet" onClick={() => review("reject")} disabled={busy || reviewFinalized}>Reject</button><button className="quiet" onClick={() => review("expert_assistance")} disabled={busy || reviewFinalized}>Escalate</button></div></div>}</div>
    <Status message={message} error={error} />
  </section>;
}

function MeetingScope() {
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<ScopeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function loadExample() { try { const payload = await api<{ transcripts: Array<{ text: string }> }>("/api/task3/v1/transcripts"); setTranscript(payload.transcripts[0]?.text ?? ""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load transcript examples."); } }
  async function submit(event: FormEvent) { event.preventDefault(); if (transcript.trim().length < 10) { setError("Provide a transcript with at least 10 characters."); return; } setBusy(true); setError(""); setMessage(""); try { setResult(await api<ScopeResult>("/api/task3/v1/scope", { method: "POST", body: JSON.stringify({ transcript, project_id: "browser-project", meeting_id: `browser-${Date.now()}`, date: new Date().toISOString().slice(0, 10) }) })); } catch (reason) { setError(reason instanceof Error ? reason.message : "Scope generation failed."); } finally { setBusy(false); } }
  async function approve() { if (!result) return; setBusy(true); try { await api(`/api/task3/v1/proposals/${result.proposal.proposal_id}/approve`, { method: "POST", body: JSON.stringify({ reviewer: "browser-reviewer" }) }); setResult({ ...result, proposal: { ...result.proposal, approval_status: "approved" } }); setMessage("Proposal approval recorded by Task 3."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Approval failed."); } finally { setBusy(false); } }
  return <section className="panel">
    <div className="section-heading"><span className="eyebrow">03 · Meeting to Scope</span><h2>Turn conversation into a reviewable proposal</h2><p>Submit transcript text to the real Task 3 workflow. Requirements, Task 1 evidence, estimates, approval, and change reports remain traceable.</p></div>
    <form onSubmit={submit} className="stack"><label htmlFor="transcript">Transcript</label><textarea id="transcript" value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="[00:01] Client: We need search and filters." rows={7} /><div className="actions"><button type="submit" disabled={busy}>{busy ? "Analyzing…" : "Generate scope"}</button><button type="button" className="quiet" onClick={loadExample} disabled={busy}>Load backend example</button></div></form>
    <Status message={message} error={error} />
    {result && <div className="scope-grid"><div><h3>Requirements</h3><ul className="plain-list">{result.requirements.map((item) => <li key={item.requirement_id}><strong>{item.status}</strong> {item.description}<small>Source: {item.source_segment_id}</small></li>)}</ul></div><div><h3>Evidence & feasibility</h3><ul className="plain-list">{result.feasibility.map((item) => <li key={item.requirement_id}><strong>{item.classification}</strong>{item.reason && <small>{item.reason}</small>}{item.evidence.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</li>)}</ul></div><div><h3>Estimates</h3><ul className="plain-list">{result.estimates.map((item) => <li key={item.requirement_id}>{item.task}<small>{item.low_hours}–{item.high_hours} hours · likely {item.likely_hours}</small></li>)}</ul></div><div className="proposal-card"><h3>Proposal v{result.proposal.version}</h3><p className="answer">{result.proposal.total_likely_hours} likely hours</p><p>{result.proposal.pricing_assumption}</p><span className="tags"><span>{result.proposal.approval_status}</span></span>{result.proposal.approval_status !== "approved" && <button onClick={approve} disabled={busy}>Approve proposal</button>}{result.changes && <div className="change-report"><h4>Follow-up changes</h4><p>Added {result.changes.added.length} · Removed {result.changes.removed.length} · Modified {result.changes.modified.length} · Unchanged {result.changes.unchanged.length}</p></div>}</div></div>}
  </section>;
}

export default function App() {
  return <main className="app-shell"><header className="hero"><div><span className="eyebrow">AI TECH CONSULTANT · LOCAL CONSOLE</span><h1>From evidence to action.</h1><p>One calm workspace for grounded answers, reviewed customer replies, and traceable project scope.</p></div><div className="health-pill"><span className="pulse" />Three services · local development</div></header><div className="dashboard"><KnowledgeBrain /><InboxAgent /><MeetingScope /></div><footer>Backend responses are authoritative. This browser client never contains provider credentials or fabricated results.</footer></main>;
}
