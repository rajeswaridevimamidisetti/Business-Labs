import { FormEvent, useEffect, useState } from "react";

type Citation = { title: string; url: string; section?: string | null };
type Email = { id: string; gmailMessageId?: string; from?: string; to?: string; subject?: string; body?: string; snippet?: string; internalDate?: string; labelIds?: string[] };
type Draft = { emailId: string; recipient?: string; subject?: string; classification: { category: string; urgency: string; risk: string }; suggestedReply: string; evidence: Citation[]; evidenceStatus?: string; humanApprovalRequired: boolean; nextAction: string };
type ReviewStatus = "pending" | "approved" | "edited" | "rejected" | "expert_assistance";
type GmailStatus = { configured: boolean; connected: boolean; account: string | null; liveSendEnabled: boolean; sync?: { status: string; importedCount: number; messages: number; error?: string } };
type Complaint = { status: string; error?: string; analysis?: { summary: string; category: string; keyIssues: string[]; urgency: string; sentiment: string; requestedResolution: string | null; relevantFacts: string[]; missingInformation: string[]; humanVerification: string[] } | null };
type ScopeResult = { requirements: Array<{ requirement_id: string; description: string; source_segment_id: string; status: string }>; feasibility: Array<{ requirement_id: string; classification: string; evidence: Citation[]; reason?: string }>; estimates: Array<{ requirement_id: string; task: string; low_hours: number; likely_hours: number; high_hours: number }>; proposal: { proposal_id: string; version: number; approval_status: string; total_likely_hours: number; pricing_assumption: string }; changes: { added: string[]; removed: string[]; modified: string[]; unchanged: string[] } | null };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem("business-labs-session");
  const headers = new Headers(options?.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
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

function AuthenticationRequired() {
  return <main className="auth-screen"><div className="auth-card"><div className="brand-mark">BL</div><span className="eyebrow">BUSINESS-LABS · AUTHENTICATED WORKSPACE</span><h1>Connect your Gmail workspace.</h1><p>Sign in through your organization&apos;s authenticated gateway to continue. Business-Labs never treats a browser-supplied account ID as identity.</p><div className="demo-notice"><strong>AUTHENTICATION REQUIRED</strong><span>Real Gmail data only · no demo inbox · live sending disabled</span></div><p className="muted">No production identity provider is bundled in this repository. After your gateway issues a valid bearer session, reload this page to access the Gmail connection flow.</p><small>Your session is checked server-side and scoped to your authenticated subject.</small></div></main>;
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
  return <section id="knowledge" className="panel">
    <div className="section-heading"><span className="eyebrow">01 · Knowledge Brain</span><h2>Grounded answers, visible evidence</h2><p>Ask the configured Knowledge Brain. Answers and abstentions come directly from Task 1.</p></div>
    <form onSubmit={submit} className="stack"><label htmlFor="question">Question</label><textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="How do settings work?" rows={4} /><button disabled={busy}>{busy ? "Searching…" : "Ask Knowledge Brain"}</button></form>
    <Status error={error} />
    {result && <div className="result-card"><div className="result-meta"><strong>{result.status.replace(/_/g, " ")}</strong><span>{result.human_help_needed ? "Human help needed" : result.sources.length ? "Retrieved KB evidence" : "No evidence"}</span></div><p className="answer">{result.answer ?? "No grounded answer was returned."}</p><h3>Sources</h3>{result.sources.length ? <ul className="source-list">{result.sources.map((source) => <li key={`${source.url}-${source.title}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{source.section && <small>{source.section}</small>}</li>)}</ul> : <p className="muted">No citations returned. Treat this response as an abstention.</p>}<small>Trace: {result.retrieval_trace.join(" · ") || "not provided"}</small></div>}
  </section>;
}

type Sitemap = { sitemap_id: string; root_url: string; interval: string; threshold: number; action: string; status: string; last_attempted: string | null; last_successful: string | null; next_scheduled: string | null; failure_reason: string | null };
type RefreshRun = { run_id: string; started_at: string; completed_at: string | null; status: string; discovered_count: number; unique_count: number; duplicate_count: number; error_count: number; pages_processed: number; pages_total: number; errors: string[] };
type RefreshUrl = { url: string; fetch_status: string; http_status: number | null; error_summary: string | null; sitemap_member: boolean; lifecycle_status: string | null; fetched_at: string | null };

function SitemapManagement() {
  const [sitemaps, setSitemaps] = useState<Sitemap[]>([]);
  const [rootUrl, setRootUrl] = useState("");
  const [interval, setInterval] = useState("daily");
  const [threshold, setThreshold] = useState("3");
  const [action, setAction] = useState("review");
  const [runs, setRuns] = useState<Record<string, RefreshRun | undefined>>({});
  const [urlRows, setUrlRows] = useState<Record<string, RefreshUrl[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const ownerId = "demo-user";
  async function load() {
    try {
      const payload = await api<{ sitemaps: Sitemap[] }>("/api/task1/sitemaps/list", { method: "POST", body: JSON.stringify({ owner_id: ownerId }) });
      setSitemaps(payload.sitemaps);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load sitemaps."); }
  }
  useEffect(() => { void load(); }, []);
  async function add(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/task1/sitemaps", { method: "POST", body: JSON.stringify({ owner_id: ownerId, root_url: rootUrl, interval, threshold: Number(threshold), action }) });
      setRootUrl(""); setMessage("Sitemap configuration saved."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save sitemap."); } finally { setBusy(false); }
  }
  async function refresh(sitemap: Sitemap) {
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = await api<{ run: RefreshRun }>(`/api/task1/sitemaps/${sitemap.sitemap_id}/refresh`, { method: "POST", body: JSON.stringify({ owner_id: ownerId }) });
      setRuns((current) => ({ ...current, [sitemap.sitemap_id]: payload.run }));
      const urls = await api<{ urls: RefreshUrl[] }>(`/api/task1/sitemaps/${sitemap.sitemap_id}/urls`, { method: "POST", body: JSON.stringify({ owner_id: ownerId, run_id: payload.run.run_id, limit: 500 }) });
      setUrlRows((current) => ({ ...current, [sitemap.sitemap_id]: urls.urls }));
      setMessage("Refresh completed. Counts are from the parsed sitemap and fetch run.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Refresh failed."); } finally { setBusy(false); }
  }
  return <section id="sitemaps" className="panel">
    <div className="section-heading"><span className="eyebrow">01 · Sitemap management</span><h2>Refreshable knowledge sources</h2><p>Configurations, refresh history, duplicate counts, and lifecycle thresholds are persisted by Task 1.</p></div>
    <form onSubmit={add} className="stack sitemap-form">
      <label htmlFor="sitemap-url">Root sitemap URL</label><input id="sitemap-url" value={rootUrl} onChange={(event) => setRootUrl(event.target.value)} placeholder="https://docs.example.com/sitemap.xml" />
      <div className="settings-row"><label>Interval<select value={interval} onChange={(event) => setInterval(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="15-days">Every 15 days</option><option value="30-days">Every 30 days</option></select></label><label>Missing threshold<select value={threshold} onChange={(event) => setThreshold(event.target.value)}>{[1, 2, 3, 7, 15, 30].map((value) => <option key={value} value={value}>{value} checks</option>)}</select></label><label>Action<select value={action} onChange={(event) => setAction(event.target.value)}><option value="review">Review</option><option value="quarantine">Quarantine</option><option value="archive">Archive</option></select></label></div>
      <button disabled={busy || !rootUrl.trim()}>Add sitemap</button>
    </form>
    {sitemaps.map((sitemap) => { const run = runs[sitemap.sitemap_id]; const rows = urlRows[sitemap.sitemap_id] ?? []; const isExpanded = expanded[sitemap.sitemap_id] ?? false; return <article className="result-card" key={sitemap.sitemap_id}><div className="result-meta"><strong>{sitemap.root_url}</strong><span>{sitemap.status} · {sitemap.interval}</span></div><p className="muted">Last attempted: {sitemap.last_attempted ?? "not yet"} · Last successful: {sitemap.last_successful ?? "not yet"} · Next: {sitemap.next_scheduled ?? "not scheduled"}</p><p className="muted">Missing action: {sitemap.action} after {sitemap.threshold} qualifying checks.</p><button onClick={() => void refresh(sitemap)} disabled={busy}>Refresh now</button>{sitemap.failure_reason && <p className="status error">{sitemap.failure_reason}</p>}{run && <div className="refresh-summary"><h3>Latest refresh</h3><p>{run.started_at} → {run.completed_at ?? "in progress"} · {run.status}</p><div className="tags"><span>{run.discovered_count} listed</span><span>{run.unique_count} unique</span><span>{run.duplicate_count} duplicates</span><span>{run.error_count} errors</span><span>{run.pages_processed}/{run.pages_total} pages</span></div><button className="quiet" onClick={() => setExpanded((current) => ({ ...current, [sitemap.sitemap_id]: !isExpanded }))}>{isExpanded ? "Hide URL results" : `Show URL results (${rows.length})`}</button>{isExpanded && <div className="url-results">{rows.map((row) => <div className="url-row" key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.url}</a><span>{row.fetch_status} · HTTP {row.http_status ?? "—"} · {row.lifecycle_status ?? "active"}</span><button className="quiet copy-url" onClick={() => void navigator.clipboard?.writeText(row.url)}>Copy</button>{row.error_summary && <small>{row.error_summary}</small>}</div>)}{!rows.length && <p className="muted">No persisted URL rows are available for this run.</p>}<strong className="url-total">Total URL entries: {run.discovered_count} · Unique: {run.unique_count} · Successfully processed: {run.pages_processed}</strong></div>}{run.errors.length > 0 && <ul className="plain-list">{run.errors.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}</article>; })}
    {!sitemaps.length && <p className="muted">No sitemap configurations yet.</p>}
    <Status message={message} error={error} />
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
  const [gmail, setGmail] = useState<GmailStatus>();
  const [complaint, setComplaint] = useState<Complaint>();
  async function loadInbox() {
    const payload = await api<{ messages: Email[] }>("/api/task2/v1/gmail/messages/local?limit=50");
    setEmails(payload.messages);
    setSelected((current) => current || payload.messages[0]?.id || "");
  }
  async function loadStatus() {
    const status = await api<GmailStatus>("/api/task2/v1/gmail/status");
    const sync = await api<GmailStatus["sync"]>("/api/task2/v1/gmail/sync/status");
    setGmail({ ...status, sync });
  }
  useEffect(() => { void Promise.all([loadInbox(), loadStatus()]).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load Gmail data.")); }, []);
  async function connectGmail() {
    try {
      const result = await api<{ authorizationUrl: string }>("/api/task2/v1/gmail/oauth/start");
      window.location.assign(result.authorizationUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start Gmail authorization."); }
  }
  async function disconnectGmail() {
    try { await api("/api/task2/v1/gmail/disconnect", { method: "POST", body: "{}" }); setGmail((current) => current ? { ...current, connected: false, account: null } : current); setMessage("Gmail disconnected."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not disconnect Gmail."); }
  }
  async function syncGmail() {
    setBusy(true); setError(""); setMessage("");
    try { const result = await api<{ imported: number; sync: NonNullable<GmailStatus["sync"]> }>("/api/task2/v1/gmail/sync", { method: "POST", body: "{}" }); setGmail((current) => current ? { ...current, sync: result.sync } : current); await loadInbox(); setMessage(`Gmail sync completed. ${result.imported} new message(s) imported.`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Gmail sync failed."); } finally { setBusy(false); }
  }
  async function analyzeComplaint() {
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ complaint: Complaint; draft: Draft }>(`/api/task2/v1/complaints/${encodeURIComponent(selected)}/analyze`, { method: "POST", body: "{}" });
      setComplaint(result.complaint); setDraft(result.draft); setReply(result.draft.suggestedReply); setReviewStatus("pending"); setMessage("Complaint analysis completed. Review the draft before approval.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Complaint analysis failed."); }
    finally { setBusy(false); }
  }
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
  async function previewSend() {
    if (!draft) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ result: { mode: string; reason: string; preview?: { to?: string; subject?: string; body?: string } } }>("/api/task2/v1/gmail/send", { method: "POST", body: JSON.stringify({ emailId: draft.emailId, dryRun: true }) });
      setMessage(`Send preview (${result.result.mode}): ${result.result.preview?.to ?? draft.recipient ?? "recipient"} — ${result.result.reason}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Send preview failed."); } finally { setBusy(false); }
  }
  const reviewFinalized = reviewStatus !== "pending";
  const email = emails.find((item) => item.id === selected);
  return <section id="inbox" className="panel">
    <div className="section-heading"><span className="eyebrow">02 · Inbox Agent</span><h2>Review real Gmail messages</h2><p>Messages below come only from the authenticated Gmail account after an explicit sync. Draft generation never sends mail.</p></div>
    <div className="result-card"><div className="result-meta"><strong>Gmail connection</strong><span>{gmail?.liveSendEnabled ? "Live sending enabled" : "Live sending disabled"}</span></div><p className="muted">{gmail?.connected ? `Connected account: ${gmail.account}` : gmail?.configured ? "Not connected" : "OAuth configuration is unavailable on this server."}</p><p className="muted">Sync: {gmail?.sync?.status ?? "idle"} · {gmail?.sync?.messages ?? 0} stored message(s)</p><div className="actions">{!gmail?.connected && <button onClick={() => void connectGmail()} disabled={!gmail?.configured || busy}>Connect Gmail</button>}{gmail?.connected && <><button onClick={() => void syncGmail()} disabled={busy}>{busy ? "Syncing…" : "Sync Gmail"}</button><button className="quiet" onClick={() => void disconnectGmail()} disabled={busy}>Disconnect</button></>}</div>{gmail?.sync?.error && <p className="status error">{gmail.sync.error}</p>}</div>
    {!emails.length && <div className="empty-state"><h3>No synchronized Gmail messages</h3><p>Connect Gmail and run a sync. If the account has no inbox messages, this state is shown without fabricated data.</p></div>}
    <div className="split"><div className="stack">{emails.length > 0 && <><label htmlFor="email">Gmail message</label><select id="email" value={selected} onChange={(event) => { setSelected(event.target.value); setDraft(undefined); setComplaint(undefined); setReviewStatus("pending"); setMessage(""); setError(""); }}>{emails.map((item) => <option key={item.id} value={item.id}>{item.subject ?? "(no subject)"}</option>)}</select>{email && <article className="email-card"><small>{email.from ?? "Unknown sender"} · {email.internalDate ?? email.id}</small><h3>{email.subject ?? "(no subject)"}</h3><p>{email.body ?? email.snippet ?? "No message content available."}</p><div className="tags">{(email.labelIds ?? []).map((label) => <span key={label}>{label}</span>)}</div></article>}<button onClick={analyzeComplaint} disabled={busy || !selected}>{busy ? "Analyzing…" : "Analyze complaint"}</button></>}</div>{complaint?.analysis && <div className="result-card"><div className="result-meta"><strong>AI complaint analysis</strong><span>{complaint.analysis.urgency} urgency · {complaint.analysis.sentiment} sentiment</span></div><p>{complaint.analysis.summary}</p><h4>Key issues</h4><ul className="plain-list">{complaint.analysis.keyIssues.map((item) => <li key={item}>{item}</li>)}</ul><p className="muted">Requested resolution: {complaint.analysis.requestedResolution ?? "Not stated"}</p><p className="muted">Missing information: {complaint.analysis.missingInformation.join("; ") || "None identified"}</p><p className="muted">Human verification: {complaint.analysis.humanVerification.join("; ") || "Review all facts before approval"}</p></div>}{draft && <div className="draft-card"><div className="result-meta"><strong>{draft.classification.category}</strong><span>{draft.classification.risk} risk · review {reviewStatus}</span></div><label htmlFor="recipient">Recipient</label><input id="recipient" value={draft.recipient ?? email?.from ?? ""} readOnly /><label htmlFor="draft-subject">Subject</label><input id="draft-subject" value={draft.subject ?? `Re: ${email?.subject ?? ""}`} readOnly /><label htmlFor="reply">Draft reply</label><textarea id="reply" value={reply} onChange={(event) => setReply(event.target.value)} rows={9} disabled={reviewFinalized} /><p className="muted">AI-generated draft · {draft.nextAction} · {reviewStatus === "approved" ? "approved for review only; live sending is disabled" : "pending human review"}</p><div className="actions"><button onClick={() => review("approve")} disabled={busy || reviewFinalized}>Approve</button><button onClick={() => review("save")} disabled={busy || reviewFinalized}>Save edit</button><button className="quiet" onClick={() => void previewSend()} disabled={busy}>Preview send</button><button className="quiet" onClick={() => review("reject")} disabled={busy || reviewFinalized}>Reject</button><button className="quiet" onClick={() => review("expert_assistance")} disabled={busy || reviewFinalized}>Escalate</button></div></div>}</div>
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
  return <section id="scope" className="panel">
    <div className="section-heading"><span className="eyebrow">03 · Meeting to Scope</span><h2>Turn conversation into a reviewable proposal</h2><p>Submit transcript text to the real Task 3 workflow. Requirements, Task 1 evidence, estimates, approval, and change reports remain traceable.</p></div>
    <form onSubmit={submit} className="stack"><label htmlFor="transcript">Transcript</label><textarea id="transcript" value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="[00:01] Client: We need search and filters." rows={7} /><div className="actions"><button type="submit" disabled={busy}>{busy ? "Analyzing…" : "Generate scope"}</button><button type="button" className="quiet" onClick={loadExample} disabled={busy}>Load backend example</button></div></form>
    <Status message={message} error={error} />
    {result && <div className="scope-grid"><div><h3>Requirements</h3><ul className="plain-list">{result.requirements.map((item) => <li key={item.requirement_id}><strong>{item.status}</strong> {item.description}<small>Source: {item.source_segment_id}</small></li>)}</ul></div><div><h3>Evidence & feasibility</h3><ul className="plain-list">{result.feasibility.map((item) => <li key={item.requirement_id}><strong>{item.classification}</strong>{item.reason && <small>{item.reason}</small>}{item.evidence.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</li>)}</ul></div><div><h3>Estimates</h3><ul className="plain-list">{result.estimates.map((item) => <li key={item.requirement_id}>{item.task}<small>{item.low_hours}–{item.high_hours} hours · likely {item.likely_hours}</small></li>)}</ul></div><div className="proposal-card"><h3>Proposal v{result.proposal.version}</h3><p className="answer">{result.proposal.total_likely_hours} likely hours</p><p>{result.proposal.pricing_assumption}</p><span className="tags"><span>{result.proposal.approval_status}</span></span>{result.proposal.approval_status !== "approved" && <button onClick={approve} disabled={busy}>Approve proposal</button>}{result.changes && <div className="change-report"><h4>Follow-up changes</h4><p>Added {result.changes.added.length} · Removed {result.changes.removed.length} · Modified {result.changes.modified.length} · Unchanged {result.changes.unchanged.length}</p></div>}</div></div>}
  </section>;
}

export default function App() {
  const [session, setSession] = useState(() => sessionStorage.getItem("business-labs-session"));
  useEffect(() => {
    if (!session) return;
    void api("/api/task2/v1/gmail/status").catch((reason) => {
      if (reason instanceof Error && /authentication|401/i.test(reason.message)) {
        sessionStorage.removeItem("business-labs-session");
        setSession(null);
      }
    });
  }, [session]);
  if (!session) return <AuthenticationRequired />;
  function logout() { sessionStorage.removeItem("business-labs-session"); setSession(null); }
  return <div className="product-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">BL</span><span>Business<span className="brand-muted">Labs</span></span></div><div className="workspace-chip"><span className="avatar">W</span><span><strong>Authenticated workspace</strong><small>GATEWAY SESSION</small></span></div><nav aria-label="Primary navigation"><a href="#overview" className="active">Overview</a><a href="#inbox">Inbox Agent</a><a href="#knowledge">Knowledge Brain</a><a href="#sitemaps">Sources</a><a href="#scope">Meeting to Scope</a></nav><div className="sidebar-bottom"><span className="demo-label">LIVE DATA · SEND DISABLED</span><button className="sidebar-logout" onClick={logout}>Log out</button></div></aside><main className="main-content"><header id="overview" className="topbar"><div><span className="eyebrow">WORKSPACE OVERVIEW</span><h1>Evidence-led work, ready for review.</h1><p>Connected services and data are reported by the backend.</p></div><div className="topbar-actions"><span className="connection-dot"><i /> Authenticated session</span><button className="quiet" onClick={logout}>Log out</button></div></header><div className="safe-banner"><strong>Live sending is disabled.</strong><span>Business-Labs will never label a preview or approved draft as sent.</span></div><div className="dashboard"><SitemapManagement /><KnowledgeBrain /><InboxAgent /><MeetingScope /></div><footer>Business-Labs - Authenticated workspace - Backend responses are authoritative</footer></main></div>;
}
