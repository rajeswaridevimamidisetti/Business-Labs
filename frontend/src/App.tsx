import { FormEvent, useEffect, useState } from "react";

type Citation = { title: string; url: string; section?: string | null };
type Email = { id: string; gmailMessageId?: string; from?: string; to?: string; subject?: string; body?: string; snippet?: string; internalDate?: string; labelIds?: string[] };
type Draft = { emailId: string; recipient?: string; subject?: string; classification: { category: string; urgency: string; risk: string }; suggestedReply: string; evidence: Citation[]; evidenceStatus?: string; humanApprovalRequired: boolean; nextAction: string };
type ReviewStatus = "pending" | "approved" | "edited" | "rejected" | "expert_assistance";
type GmailStatus = { configured: boolean; connected: boolean; needsReconnect?: boolean; missingScopes?: string[]; account: string | null; liveSendEnabled: boolean; sync?: { status: string; importedCount: number; messages: number; error?: string } };
type Complaint = { status: string; error?: string; analysis?: { summary: string; category: string; keyIssues: string[]; urgency: string; sentiment: string; requestedResolution: string | null; relevantFacts: string[]; missingInformation: string[]; humanVerification: string[] } | null };
type ScopeResult = { requirements: Array<{ requirement_id: string; description: string; source_segment_id: string; status: string }>; feasibility: Array<{ requirement_id: string; classification: string; evidence: Citation[]; reason?: string }>; estimates: Array<{ requirement_id: string; task: string; low_hours: number; likely_hours: number; high_hours: number }>; proposal: { proposal_id: string; version: number; approval_status: string; total_likely_hours: number; pricing_assumption: string }; changes: { added: string[]; removed: string[]; modified: string[]; unchanged: string[] } | null };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, { ...options, headers, credentials: "include" });
  const body = await response.text();
  let payload: (T & { error?: string; message?: string }) | undefined;
  if (body.trim()) {
    try {
      payload = JSON.parse(body) as T & { error?: string; message?: string };
    } catch {
      throw new Error(`Service returned invalid JSON (${response.status}).`);
    }

  }
  if (response.status === 401) window.dispatchEvent(new Event("business-labs-auth-expired"));
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

function AuthenticationRequiredV2({ providerConfigured, error, onLogin }: { providerConfigured: boolean; error?: string; onLogin: () => void }) {
  return <main className="auth-screen"><div className="auth-card"><div className="brand-mark">BL</div><span className="eyebrow">BUSINESS-LABS · AUTHENTICATED WORKSPACE</span><h1>Sign in to connect your Gmail workspace.</h1><p>Business-Labs verifies your identity with Google OpenID Connect before Gmail or draft operations are available.</p><div className="demo-notice"><strong>{providerConfigured ? "AUTHENTICATION REQUIRED" : "IDENTITY PROVIDER NOT CONFIGURED"}</strong><span>Real Gmail data only · no demo inbox · live sending disabled</span></div>{error && <p className="status error">{error}</p>}{providerConfigured ? <button onClick={onLogin}>Sign in with Google</button> : <p className="muted">Configure the Google OIDC variables on the backend, then reload this page. See AUDIT_REPORT.md.</p>}<small>Your session is checked server-side and scoped to your authenticated subject.</small></div></main>;
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
type ImportStats = { total_sitemap_urls: number; article_urls_discovered: number; article_urls_in_database: number; successfully_extracted: number; pending_articles: number; failed_articles: number; skipped_articles: number; new_articles_last_run: number; updated_articles_last_run: number; current_run_status: string; last_run_started_at: string | null; last_run_completed_at: string | null };

function SitemapManagement() {
  const [sitemaps, setSitemaps] = useState<Sitemap[]>([]);
  const [rootUrl, setRootUrl] = useState("");
  const [interval, setInterval] = useState("daily");
  const [threshold, setThreshold] = useState("3");
  const [action, setAction] = useState("review");
  const [runs, setRuns] = useState<Record<string, RefreshRun | undefined>>({});
  const [stats, setStats] = useState<Record<string, ImportStats | undefined>>({});
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
      const entries = await Promise.all(payload.sitemaps.map(async (sitemap) => {
        const result = await api<{ stats: ImportStats }>(`/api/task1/sitemaps/${sitemap.sitemap_id}/stats`, { method: "POST", body: JSON.stringify({ owner_id: ownerId }) });
        return [sitemap.sitemap_id, result.stats] as const;
      }));
      setStats(Object.fromEntries(entries));
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
    {sitemaps.map((sitemap) => { const run = runs[sitemap.sitemap_id]; const summary = stats[sitemap.sitemap_id]; const rows = urlRows[sitemap.sitemap_id] ?? []; const isExpanded = expanded[sitemap.sitemap_id] ?? false; return <article className="result-card" key={sitemap.sitemap_id}><div className="result-meta"><strong>{sitemap.root_url}</strong><span>{sitemap.status} · {sitemap.interval}</span></div><p className="muted">Last attempted: {sitemap.last_attempted ?? "not yet"} · Last successful: {sitemap.last_successful ?? "not yet"} · Next: {sitemap.next_scheduled ?? "not scheduled"}</p><p className="muted">Missing action: {sitemap.action} after {sitemap.threshold} qualifying checks.</p>{summary && <div className="tags"><span>Sitemap URLs: {summary.total_sitemap_urls}</span><span>Articles: {summary.article_urls_discovered}</span><span>Stored: {summary.article_urls_in_database}</span><span>Extracted: {summary.successfully_extracted}</span><span>Pending: {summary.pending_articles}</span><span>Failed: {summary.failed_articles}</span><span>New: {summary.new_articles_last_run}</span><span>Updated: {summary.updated_articles_last_run}</span></div>}<button onClick={() => void refresh(sitemap)} disabled={busy}>Refresh now</button>{sitemap.failure_reason && <p className="status error">{sitemap.failure_reason}</p>}{run && <div className="refresh-summary"><h3>Latest refresh</h3><p>{run.started_at} → {run.completed_at ?? "in progress"} · {run.status}</p><div className="tags"><span>{run.discovered_count} listed</span><span>{run.unique_count} unique</span><span>{run.duplicate_count} duplicates</span><span>{run.error_count} errors</span><span>{run.pages_processed}/{run.pages_total} pages</span></div><button className="quiet" onClick={() => setExpanded((current) => ({ ...current, [sitemap.sitemap_id]: !isExpanded }))}>{isExpanded ? "Hide URL results" : `Show URL results (${rows.length})`}</button>{isExpanded && <div className="url-results">{rows.map((row) => <div className="url-row" key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.url}</a><span>{row.fetch_status} · HTTP {row.http_status ?? "—"} · {row.lifecycle_status ?? "active"}</span><button className="quiet copy-url" onClick={() => void navigator.clipboard?.writeText(row.url)}>Copy</button>{row.error_summary && <small>{row.error_summary}</small>}</div>)}{!rows.length && <p className="muted">No persisted URL rows are available for this run.</p>}<strong className="url-total">Total URL entries: {run.discovered_count} · Unique: {run.unique_count} · Successfully processed: {run.pages_processed}</strong></div>}{run.errors.length > 0 && <ul className="plain-list">{run.errors.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}</article>; })}
    {!sitemaps.length && <p className="muted">No sitemap configurations yet.</p>}
    <Status message={message} error={error} />
  </section>;
}

type SitemapExtractionStats = { available: boolean; source_url: string | null; extracted_at: string | null; total_sitemap_urls: number; unique_sitemap_urls: number; article_urls_identified: number; unique_article_urls_saved: number; duplicate_urls_removed: number; rejected_urls: number };
type StoredSitemapUrl = { url: string; is_article: boolean; last_seen_at: string };

function SitemapExtractionReview() {
  const [stats, setStats] = useState<SitemapExtractionStats>();
  const [urls, setUrls] = useState<StoredSitemapUrl[]>([]);
  const [search, setSearch] = useState("");
  const [articleOnly, setArticleOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const ownerId = "demo-user";
  const pageSize = 50;
  async function loadStats() {
    const response = await api<{ stats: SitemapExtractionStats }>("/api/task1/sitemap-data/stats", { method: "POST", body: JSON.stringify({ owner_id: ownerId }) });
    setStats(response.stats);
  }
  async function loadUrls() {
    const response = await api<{ urls: StoredSitemapUrl[]; total: number }>("/api/task1/sitemap-data/urls", { method: "POST", body: JSON.stringify({ owner_id: ownerId, search, article_only: articleOnly, limit: pageSize, offset: page * pageSize }) });
    setUrls(response.urls); setTotal(response.total);
  }
  useEffect(() => { void loadStats().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load extraction counts.")); }, []);
  useEffect(() => { setBusy(true); void loadUrls().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load saved URLs.")).finally(() => setBusy(false)); }, [search, articleOnly, page]);
  return <section id="sitemap-extraction" className="panel">
    <div className="section-heading"><span className="eyebrow">Step 1 · Local sitemap extraction</span><h2>Saved sitemap URLs</h2><p>Counts and URLs come from the local extraction tables. This view does not fetch the live sitemap.</p></div>
    {error && <Status error={error} />}
    {!stats?.available ? <p className="muted">No local sitemap extraction is available yet. Supply the XML file and run the documented extraction command.</p> : <>
      <div className="tags"><span>Total Sitemap URLs: {stats.total_sitemap_urls}</span><span>Unique Sitemap URLs: {stats.unique_sitemap_urls}</span><span>Article URLs Identified: {stats.article_urls_identified}</span><span>Unique Article URLs Saved: {stats.unique_article_urls_saved}</span><span>Duplicates: {stats.duplicate_urls_removed}</span><span>Rejected: {stats.rejected_urls}</span></div>
      <div className="settings-row"><label htmlFor="sitemap-url-search">Search saved URLs<input id="sitemap-url-search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Filter URLs" /></label><label>List<select value={articleOnly ? "articles" : "all"} onChange={(event) => { setArticleOnly(event.target.value === "articles"); setPage(0); }}><option value="all">All Sitemap URLs</option><option value="articles">Article URLs only</option></select></label></div>
      <h3>{articleOnly ? "Article URLs" : "All Sitemap URLs"} <small>({total})</small></h3>
      {busy ? <p className="muted">Loading saved URLs…</p> : urls.length ? <div className="url-results">{urls.map((item) => <div className="url-row" key={item.url}><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a><small>{item.is_article ? "article" : "sitemap URL"}</small></div>)}</div> : <p className="muted">No saved URLs match this filter.</p>}
      <div className="result-meta"><span>Showing {urls.length} of {total}</span><span><button className="quiet" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="quiet" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Next</button></span></div>
    </>}
  </section>;
}

type SitemapDataStats = { available: boolean; source_url: string | null; extracted_at: string | null; total_sitemap_urls: number; unique_sitemap_urls: number; article_urls_identified: number; unique_article_urls_saved: number; duplicate_urls_removed: number; rejected_urls: number; documents_fetched: number; latest_import_id?: string };
type SitemapTableRow = { url: string; is_article: boolean; source_url: string; first_seen_at: string; last_seen_at: string; processing_status: string; http_status: number | null; last_successful_at: string | null; lifecycle_status: string | null };

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

async function downloadSitemapExport(urlType: "all" | "article" | "other", format: "txt" | "csv", search = "") {
  const payload = await api<{ export: { filename: string; content_type: string; content: string } }>("/api/task1/sitemap-data/export", { method: "POST", body: JSON.stringify({ owner_id: "demo-user", url_type: urlType, format, search }) });
  const blob = new Blob([payload.export.content], { type: payload.export.content_type });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = payload.export.filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  return payload.export.content;
}

function SitemapWorkspace() {
  const ownerId = "demo-user";
  const [sitemaps, setSitemaps] = useState<Sitemap[]>([]);
  const [stats, setStats] = useState<SitemapDataStats>();
  const [rows, setRows] = useState<SitemapTableRow[]>([]);
  const [selectedSitemapId, setSelectedSitemapId] = useState("");
  const [search, setSearch] = useState("");
  const [urlType, setUrlType] = useState<"all" | "article" | "other">("all");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<RefreshRun[]>([]);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newRootUrl, setNewRootUrl] = useState("");
  const [newInterval, setNewInterval] = useState("daily");
  const [newThreshold, setNewThreshold] = useState("3");
  const [newAction, setNewAction] = useState("review");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function loadSourceData() {
    const [sourcePayload, statsPayload] = await Promise.all([
      api<{ sitemaps: Sitemap[] }>("/api/task1/sitemaps/list", { method: "POST", body: JSON.stringify({ owner_id: ownerId }) }),
      api<{ stats: SitemapDataStats }>("/api/task1/sitemap-data/stats", { method: "POST", body: JSON.stringify({ owner_id: ownerId }) }),
    ]);
    setSitemaps(sourcePayload.sitemaps);
    setStats(statsPayload.stats);
    setSelectedSitemapId((current) => current || sourcePayload.sitemaps.find((item) => item.root_url === statsPayload.stats.source_url)?.sitemap_id || sourcePayload.sitemaps[0]?.sitemap_id || "");
  }

  async function loadRows() {
    setLoading(true);
    try {
      const payload = await api<{ urls: SitemapTableRow[]; total: number }>("/api/task1/sitemap-data/urls", { method: "POST", body: JSON.stringify({ owner_id: ownerId, search, url_type: urlType, limit: pageSize, offset: page * pageSize }) });
      setRows(payload.urls); setTotal(payload.total);
      if (page >= Math.max(1, Math.ceil(payload.total / pageSize))) setPage(0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load saved sitemap URLs."); setRows([]); setTotal(0); } finally { setLoading(false); }
  }

  async function loadHistory(sitemapId: string) {
    if (!sitemapId) { setHistory([]); return; }
    try {
      const payload = await api<{ runs: RefreshRun[] }>(`/api/task1/sitemaps/${sitemapId}/runs`, { method: "POST", body: JSON.stringify({ owner_id: ownerId }) });
      setHistory(payload.runs);
    } catch (reason) {
      setHistory([]);
      setError(reason instanceof Error ? reason.message : "Could not load refresh history.");
    }
  }

  useEffect(() => { void loadSourceData().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load sitemap data.")); }, []);
  useEffect(() => { void loadRows(); }, [search, urlType, pageSize, page]);
  useEffect(() => { void loadHistory(selectedSitemapId); }, [selectedSitemapId]);

  async function refresh() {
    if (!selectedSitemapId || refreshing) return;
    setRefreshing(true); setError(""); setMessage("");
    try {
      await api(`/api/task1/sitemap-data/refresh`, { method: "POST", body: JSON.stringify({ owner_id: ownerId, sitemap_id: selectedSitemapId }) });
      await loadSourceData();
      setPage(0);
      await loadRows();
      await loadHistory(selectedSitemapId);
      setMessage("Sitemap refresh completed. Counts and URL rows are current.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sitemap refresh failed."); } finally { setRefreshing(false); }
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    setAdding(true); setError(""); setMessage("");
    try {
      await api("/api/task1/sitemaps", { method: "POST", body: JSON.stringify({ owner_id: ownerId, root_url: newRootUrl, interval: newInterval, threshold: Number(newThreshold), action: newAction }) });
      setNewRootUrl(""); setShowAddSource(false);
      await loadSourceData();
      setMessage("Sitemap source added. Refresh it to import its URL inventory.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add sitemap source."); } finally { setAdding(false); }
  }

  async function copyUrl(url: string) {
    try { await navigator.clipboard.writeText(url); setMessage("URL copied to the clipboard."); } catch { setError("Clipboard access was unavailable."); }
  }

  async function copyAll() {
    try { const content = await downloadSitemapExport(urlType, "txt", search); await navigator.clipboard.writeText(content); setMessage(`Copied ${content.trim() ? content.trim().split("\\n").length : 0} matching URLs.`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not copy matching URLs."); }
  }

  const selected = sitemaps.find((item) => item.sitemap_id === selectedSitemapId);
  return <section id="sitemaps" className="workspace-section">
    <div className="page-heading"><div><span className="eyebrow">01 · REFRESHABLE KNOWLEDGE SOURCES</span><h2>Sitemap management</h2><p>Monitor source health, refresh the live sitemap, and review every persisted URL before article extraction begins.</p></div><div className="heading-actions"><span className="live-pill"><i /> Data is persisted locally</span><button onClick={() => void refresh()} disabled={!selectedSitemapId || refreshing}>{refreshing ? "Refreshing…" : "Refresh sitemap"}</button></div></div>
    <div className="metric-grid six-up">
      <div className="metric-card"><span className="metric-icon teal">↗</span><div><strong>{stats?.unique_sitemap_urls ?? "—"}</strong><span>Total URLs saved</span></div></div>
      <div className="metric-card"><span className="metric-icon blue">▦</span><div><strong>{stats?.unique_article_urls_saved ?? "—"}</strong><span>Article URLs</span></div></div>
      <div className="metric-card"><span className="metric-icon violet">◫</span><div><strong>{stats?.documents_fetched ?? "—"}</strong><span>Sitemaps processed</span></div></div>
      <div className="metric-card"><span className="metric-icon amber">◷</span><div><strong className="metric-date">{formatTimestamp(stats?.extracted_at).replace(/,? \d{4}/, "")}</strong><span>Last refresh</span></div></div>
      <div className="metric-card"><span className="metric-icon red">!</span><div><strong>{stats?.rejected_urls ?? "—"}</strong><span>Rejected URLs</span></div></div>
      <div className="metric-card"><span className="metric-icon slate">≋</span><div><strong>{stats?.duplicate_urls_removed ?? "—"}</strong><span>Duplicates removed</span></div></div>
    </div>
     <div className="source-toolbar"><button className="quiet" onClick={() => setShowAddSource((current) => !current)}>{showAddSource ? "Close add form" : "Add source"}</button></div>
     {showAddSource && <form className="inline-source-form" onSubmit={addSource}><label>Source sitemap URL<input value={newRootUrl} onChange={(event) => setNewRootUrl(event.target.value)} placeholder="https://support.example.com/sitemap.xml" required /></label><div className="settings-row"><label>Interval<select value={newInterval} onChange={(event) => setNewInterval(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="15-days">Every 15 days</option><option value="30-days">Every 30 days</option></select></label><label>Threshold<select value={newThreshold} onChange={(event) => setNewThreshold(event.target.value)}>{[1, 2, 3, 7, 15, 30].map((value) => <option key={value} value={value}>{value} checks</option>)}</select></label><label>Action<select value={newAction} onChange={(event) => setNewAction(event.target.value)}><option value="review">Review</option><option value="quarantine">Quarantine</option><option value="archive">Archive</option></select></label></div><button disabled={adding}>{adding ? "Adding..." : "Save source"}</button></form>}
     {selected && <article className="surface-card history-panel"><div className="card-heading"><div><span className="eyebrow">REFRESH HISTORY</span><h3>Recent discovery runs</h3></div><span className="count-badge">{history.length}</span></div>{history.length ? <div className="history-list">{history.slice(0, 5).map((run) => <div className="history-row" key={run.run_id}><span className={`status-badge ${run.status === "completed" ? "success" : "danger"}`}>{run.status}</span><div><strong>{run.unique_count.toLocaleString()} unique URLs</strong><small>{formatTimestamp(run.started_at)} Â· {run.pages_total || 1} sitemap document(s)</small></div><span>{run.error_count ? `${run.error_count} errors` : `${run.duplicate_count} duplicates`}</span></div>)}</div> : <p className="muted">No refresh runs recorded yet.</p>}</article>}
     <div className="content-grid source-layout">
      <article className="surface-card source-panel"><div className="card-heading"><div><span className="eyebrow">SOURCE REGISTRY</span><h3>Configured sources</h3></div><span className="count-badge">{sitemaps.length} active</span></div>{sitemaps.length ? <div className="source-list-grid">{sitemaps.map((source) => { const active = source.sitemap_id === selectedSitemapId; const matchesImport = stats?.source_url === source.root_url; return <button className={`source-card ${active ? "selected" : ""}`} key={source.sitemap_id} onClick={() => setSelectedSitemapId(source.sitemap_id)}><span className="source-status"><i className={source.status === "failed" ? "offline" : ""} />{source.status}</span><strong>{new URL(source.root_url).hostname}</strong><span className="source-url">{source.root_url}</span><span className="source-meta">{matchesImport ? `${stats?.unique_sitemap_urls ?? 0} URLs · ${stats?.unique_article_urls_saved ?? 0} articles` : "No import metrics yet"}</span><small>Last refresh: {matchesImport ? formatTimestamp(stats?.extracted_at) : formatTimestamp(source.last_successful)}</small></button>; })}</div> : <div className="empty-state"><strong>No configured sources</strong><span>Add a sitemap source to begin.</span></div>}<Status message={message} error={error} /></article>
      <article className="surface-card refresh-panel"><div className="card-heading"><div><span className="eyebrow">SELECTED SOURCE</span><h3>{selected ? new URL(selected.root_url).hostname : "No source selected"}</h3></div><span className={`status-badge ${selected?.status === "failed" ? "danger" : "success"}`}>{selected?.status ?? "idle"}</span></div>{selected ? <><p className="source-url large">{selected.root_url}</p><dl className="detail-list"><div><dt>Last attempted</dt><dd>{formatTimestamp(selected.last_attempted)}</dd></div><div><dt>Last successful</dt><dd>{formatTimestamp(selected.last_successful ?? stats?.extracted_at)}</dd></div><div><dt>Refresh interval</dt><dd>{selected.interval}</dd></div><div><dt>Failure policy</dt><dd>{selected.action} after {selected.threshold} checks</dd></div></dl>{selected.failure_reason && <p className="inline-error">{selected.failure_reason}</p>}<button className="secondary-action" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Fetching and validating…" : "Refresh selected source"}</button></> : <p className="muted">Configure a source to enable refresh.</p>}</article>
    </div>
    <article className="surface-card url-browser"><div className="card-heading"><div><span className="eyebrow">PERSISTED URL INVENTORY</span><h3>All sitemap URLs</h3><p>Search and paginate across the complete saved dataset. Article content is not fetched here.</p></div><div className="export-actions"><button className="quiet" onClick={() => void copyAll()} disabled={!total}>Copy matching</button><button className="quiet" onClick={() => void downloadSitemapExport(urlType, "txt", search)} disabled={!total}>Download TXT</button><button className="quiet" onClick={() => void downloadSitemapExport(urlType, "csv", search)} disabled={!total}>Download CSV</button></div></div><div className="table-toolbar"><label className="search-field"><span>Search URLs</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search by full or partial URL" /></label><label><span>URL type</span><select value={urlType} onChange={(event) => { setUrlType(event.target.value as "all" | "article" | "other"); setPage(0); }}><option value="all">All URLs</option><option value="article">Article URLs</option><option value="other">Other URLs</option></select></label><label><span>Rows per page</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option><option value={250}>250</option></select></label></div><div className="table-summary"><span><strong>{total.toLocaleString()}</strong> matching records</span><span>Page {Math.min(page + 1, pageCount)} of {pageCount}</span></div>{loading ? <div className="table-skeleton" aria-label="Loading sitemap URLs"><span /><span /><span /><span /><span /></div> : rows.length ? <div className="table-scroll"><table><thead><tr><th>#</th><th>URL</th><th>Type</th><th>Source</th><th>First discovered</th><th>Last seen</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.url}><td className="row-number">{page * pageSize + index + 1}</td><td className="url-cell"><a href={row.url} target="_blank" rel="noreferrer">{row.url}</a></td><td><span className={`type-pill ${row.is_article ? "article" : "other"}`}>{row.is_article ? "Article" : "Other"}</span></td><td className="source-cell">{row.source_url}</td><td>{formatTimestamp(row.first_seen_at)}</td><td>{formatTimestamp(row.last_seen_at)}</td><td><span className="table-status">{row.processing_status}</span>{row.http_status && <small>HTTP {row.http_status}</small>}</td><td><button className="icon-button" aria-label={`Copy ${row.url}`} title="Copy URL" onClick={() => void copyUrl(row.url)}>⧉</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No matching URLs</strong><span>Try a different search or filter.</span></div>}<div className="pagination"><span>Showing {rows.length ? page * pageSize + 1 : 0}–{Math.min((page + 1) * pageSize, total)} of {total.toLocaleString()}</span><div><button className="quiet" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0 || loading}>Previous</button><button className="quiet" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page >= pageCount - 1 || loading}>Next</button></div></div></article>
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
    <div className="result-card"><div className="result-meta"><strong>Gmail connection</strong><span>{gmail?.liveSendEnabled ? "Live sending enabled" : "Live sending disabled"}</span></div><p className="muted">{gmail?.connected ? `Connected account: ${gmail.account}` : gmail?.needsReconnect ? "Reconnect required: the stored Gmail authorization is missing required scopes." : gmail?.configured ? "Not connected" : "OAuth configuration is unavailable on this server."}</p><p className="muted">Sync: {gmail?.sync?.status ?? "idle"} · {gmail?.sync?.messages ?? 0} stored message(s)</p><div className="actions">{!gmail?.connected && <button onClick={() => void connectGmail()} disabled={!gmail?.configured || busy}>{gmail?.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}</button>}{gmail?.connected && <><button onClick={() => void syncGmail()} disabled={busy}>{busy ? "Syncing…" : "Sync Gmail"}</button><button className="quiet" onClick={() => void disconnectGmail()} disabled={busy}>Disconnect</button></>}</div>{gmail?.sync?.error && <p className="status error">{gmail.sync.error}</p>}</div>
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

function DashboardHome({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [stats, setStats] = useState<SitemapDataStats>();
  const [error, setError] = useState("");
  useEffect(() => { void api<{ stats: SitemapDataStats }>("/api/task1/sitemap-data/stats", { method: "POST", body: JSON.stringify({ owner_id: "demo-user" }) }).then((payload) => setStats(payload.stats)).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load dashboard metrics.")); }, []);
  return <section className="workspace-section"><div className="page-heading"><div><span className="eyebrow">WORKSPACE OVERVIEW</span><h2>Your consultant command center</h2><p>Evidence-led operations across knowledge, sources, inbox review, and project scoping.</p></div><span className="live-pill"><i /> Authenticated workspace</span></div><div className="metric-grid four-up"><div className="metric-card"><span className="metric-icon teal">↗</span><div><strong>{stats?.unique_sitemap_urls ?? "—"}</strong><span>Saved sitemap URLs</span></div></div><div className="metric-card"><span className="metric-icon blue">▦</span><div><strong>{stats?.unique_article_urls_saved ?? "—"}</strong><span>Article sources</span></div></div><div className="metric-card"><span className="metric-icon violet">◫</span><div><strong>{stats?.documents_fetched ?? "—"}</strong><span>Sitemap documents</span></div></div><div className="metric-card"><span className="metric-icon amber">◷</span><div><strong>{formatTimestamp(stats?.extracted_at).split(",")[0]}</strong><span>Latest refresh</span></div></div></div><div className="overview-grid"><article className="surface-card welcome-card"><span className="eyebrow">AI IT CONSULTANT</span><h3>Make every answer reviewable.</h3><p>Ask grounded questions, inspect source evidence, and turn meeting transcripts into actionable proposals. Real integrations remain authoritative; draft actions stay reviewable.</p><div className="actions"><button onClick={() => onNavigate("knowledge")}>Ask Knowledge Brain</button><button className="quiet" onClick={() => onNavigate("sitemaps")}>Manage sources</button></div></article><article className="surface-card quick-card"><div className="card-heading"><div><span className="eyebrow">SYSTEM SNAPSHOT</span><h3>Operational status</h3></div><span className="status-badge success">Live</span></div><div className="snapshot-row"><span>Knowledge Brain</span><strong>Evidence-first</strong></div><div className="snapshot-row"><span>Gmail</span><strong>Approval required</strong></div><div className="snapshot-row"><span>Outbound email</span><strong>Disabled</strong></div><div className="snapshot-row"><span>Last source refresh</span><strong>{formatTimestamp(stats?.extracted_at)}</strong></div></article></div>{error && <Status error={error} />}</section>;
}

function SystemStatus() {
  const [services, setServices] = useState<Array<{ name: string; endpoint: string; status: string }>>([]);
  useEffect(() => { const endpoints = [{ name: "Knowledge Brain", endpoint: "/api/task1/health" }, { name: "Inbox Agent", endpoint: "/api/task2/health" }, { name: "Meeting to Scope", endpoint: "/api/task3/health" }]; void Promise.all(endpoints.map(async (service) => { try { const response = await fetch(service.endpoint); return { ...service, status: response.ok ? "Operational" : `HTTP ${response.status}` }; } catch { return { ...service, status: "Unavailable" }; } })).then(setServices); }, []);
  return <section className="workspace-section"><div className="page-heading"><div><span className="eyebrow">SETTINGS · SYSTEM STATUS</span><h2>Platform health</h2><p>Local service checks and safety configuration reported by the running environment.</p></div></div><div className="surface-card status-list">{services.map((service) => <div className="system-row" key={service.name}><span className="system-dot" /><div><strong>{service.name}</strong><small>{service.endpoint}</small></div><span className="status-badge success">{service.status}</span></div>)}<div className="system-row"><span className="system-dot" /><div><strong>Gmail live sending</strong><small>Safety control</small></div><span className="status-badge success">Disabled</span></div></div></section>;
}

export default function App() {
  const [session, setSession] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [authError, setAuthError] = useState("");
  const [activeView, setActiveView] = useState("overview");
  useEffect(() => {
    const loginError = new URLSearchParams(window.location.search).get("auth_error");
    if (loginError) setAuthError(loginError === "provider_denied" ? "Google sign-in was cancelled or denied. Try Sign in with Google again and approve the requested identity permissions." : loginError.includes("discovery request failed") ? "The backend could not reach Google’s identity service. Check backend outbound HTTPS access and try again." : loginError.includes("token exchange request failed") ? "The backend could not complete the Google token exchange. Check backend outbound HTTPS access and verify the OAuth callback configuration." : `Sign-in could not be completed: ${loginError}`);
    const onExpired = () => { setSession(false); setAuthError("Your session expired. Sign in again to continue."); };
    window.addEventListener("business-labs-auth-expired", onExpired);
    void api<{ authenticated: boolean; providerConfigured: boolean }>("/api/task2/v1/auth/session").then((status) => { setProviderConfigured(status.providerConfigured); setSession(status.authenticated); }).catch(() => setAuthError("The authentication service is unavailable.")).finally(() => setAuthLoading(false));
    return () => window.removeEventListener("business-labs-auth-expired", onExpired);
  }, []);
  if (authLoading) return <main className="auth-screen"><div className="auth-card"><div className="brand-mark">BL</div><p>Checking your authenticated session…</p></div></main>;
  if (!session) return <AuthenticationRequiredV2 providerConfigured={providerConfigured} error={authError} onLogin={() => window.location.assign("/api/task2/v1/auth/login")} />;
  async function logout() { await api("/api/task2/v1/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined); setSession(false); }
  const nav = [["overview", "Overview", "⌂"], ["knowledge", "Knowledge Brain", "✦"], ["sitemaps", "Sitemap Management", "⌁"], ["inbox", "Inbox Agent", "✉"], ["scope", "Meeting to Scope", "◌"], ["status", "System Status", "✓"]];
  if (activeView !== "__legacy__") return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">AI</span><span>AI <span className="brand-muted">IT Consultant</span></span></div><div className="workspace-chip"><span className="avatar">W</span><span><strong>Authenticated workspace</strong><small>LIVE OPERATIONS</small></span></div><div className="nav-label">WORKSPACE</div><nav aria-label="Primary navigation">{nav.map(([view, label, icon]) => <button key={view} className={`nav-item ${activeView === view ? "active" : ""}`} onClick={() => setActiveView(view)}><span className="nav-icon">{icon}</span><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><div className="safety-chip"><span className="safety-dot" /> Live sending disabled</div><button className="sidebar-logout" onClick={logout}>Log out</button></div></aside><main className="main-content"><header className="topbar"><div><span className="breadcrumb">AI IT CONSULTANT <span>/</span> {nav.find(([view]) => view === activeView)?.[1]}</span><h1>{activeView === "overview" ? "Your consultant command center" : nav.find(([view]) => view === activeView)?.[1]}</h1><p>{activeView === "sitemaps" ? "Refreshable knowledge sources and complete URL inventory." : "Review connected services, evidence, and next actions."}</p></div><div className="topbar-actions"><span className="connection-dot"><i /> Session verified</span><button className="quiet" onClick={logout}>Log out</button></div></header><div className="safe-banner"><span className="banner-icon">✓</span><div><strong>Review-first workspace</strong><span>AI drafts require human approval. Live email sending is disabled.</span></div></div><div className="dashboard">{activeView === "overview" && <DashboardHome onNavigate={setActiveView} />}{activeView === "knowledge" && <KnowledgeBrain />}{activeView === "sitemaps" && <SitemapWorkspace />}{activeView === "inbox" && <InboxAgent />}{activeView === "scope" && <MeetingScope />}{activeView === "status" && <SystemStatus />}</div><footer>AI IT Consultant · Authenticated workspace · Backend responses are authoritative</footer></main></div>;
  return <div className="product-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">BL</span><span>Business<span className="brand-muted">Labs</span></span></div><div className="workspace-chip"><span className="avatar">W</span><span><strong>Authenticated workspace</strong><small>GATEWAY SESSION</small></span></div><nav aria-label="Primary navigation"><a href="#overview" className="active">Overview</a><a href="#inbox">Inbox Agent</a><a href="#knowledge">Knowledge Brain</a><a href="#sitemaps">Sources</a><a href="#sitemap-extraction">Sitemap URLs</a><a href="#scope">Meeting to Scope</a></nav><div className="sidebar-bottom"><span className="demo-label">LIVE DATA · SEND DISABLED</span><button className="sidebar-logout" onClick={logout}>Log out</button></div></aside><main className="main-content"><header id="overview" className="topbar"><div><span className="eyebrow">WORKSPACE OVERVIEW</span><h1>Evidence-led work, ready for review.</h1><p>Connected services and data are reported by the backend.</p></div><div className="topbar-actions"><span className="connection-dot"><i /> Authenticated session</span><button className="quiet" onClick={logout}>Log out</button></div></header><div className="safe-banner"><strong>Live sending is disabled.</strong><span>Business-Labs will never label a preview or approved draft as sent.</span></div><div className="dashboard"><SitemapManagement /><SitemapExtractionReview /><KnowledgeBrain /><InboxAgent /><MeetingScope /></div><footer>Business-Labs - Authenticated workspace - Backend responses are authoritative</footer></main></div>;
}
