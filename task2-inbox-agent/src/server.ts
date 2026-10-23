import { createServer } from "node:http";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { queryHowToKnowledge, buildKnowledgeQuestion, Task1Client, Task1ClientError } from "./task1-client.js";
import { createDraft } from "./drafts.js";
import { findEmail } from "./email-lookup.js";
import { ReviewAlreadyFinalizedError, ReviewWorkflow } from "./review.js";
import { ReviewAction } from "./schemas.js";
import { classifyEmailDeterministically } from "./classifier.js";
import { FeedbackStore } from "./feedback.js";
import { GmailClient } from "./gmail.js";
import { GmailOAuth, loadOAuthConfig, OAuthConfigurationError } from "./oauth.js";
import { GmailSyncStore } from "./sync-store.js";
import { DraftStore } from "./draft-store.js";
import { authenticateRequest, AuthenticationError, clearSessionCookie, sessionCookie } from "./auth.js";
import { completeLogin, createLogin, loadOidcConfig, OidcAuthenticationError, oidcConfigured } from "./oidc.js";
import { AiConfigurationError, configuredComplaintAnalyzer } from "./complaints.js";

function loadLocalEnvironment(): void {
  const path = process.env.TASK2_ENV_PATH ?? ".env";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

loadLocalEnvironment();
const port = Number(process.env.TASK2_PORT ?? "8002");
const oidcConfig = loadOidcConfig(process.env, port);
const task1 = new Task1Client({ baseUrl: process.env.TASK1_BASE_URL ?? "http://127.0.0.1:8001" });
const feedbackPath = process.env.TASK2_FEEDBACK_PATH ?? "data/local/task2-feedback.json";
mkdirSync(dirname(feedbackPath), { recursive: true });
const feedback = new FeedbackStore(feedbackPath);
const draftStore = new DraftStore();
const gmail = new GmailClient({
  accessToken: process.env.GMAIL_ACCESS_TOKEN,
  userId: process.env.GMAIL_USER_ID,
  liveSendEnabled: process.env.GMAIL_LIVE_SEND_ENABLED === "true",
});
let oauthConfig;
try {
  oauthConfig = loadOAuthConfig(process.env, `http://127.0.0.1:${port}/v1/gmail/oauth/callback`);
} catch (error: unknown) {
  oauthConfig = undefined;
  if (error instanceof OAuthConfigurationError) console.warn(error.message);
}
const gmailOAuth = new GmailOAuth({
  ...oauthConfig,
  encryptionKey: process.env.GMAIL_TOKEN_ENCRYPTION_KEY,
  tokenPath: process.env.GMAIL_TOKEN_PATH ?? "data/local/gmail-tokens.enc",
});
const syncStore = new GmailSyncStore(process.env.GMAIL_SYNC_PATH ?? "data/local/gmail-sync.json");
function syncedEmail(ownerId: string, emailId: unknown) {
  if (typeof emailId !== "string") return undefined;
  const message = syncStore.messages(ownerId, 500, 0).find((item) => item.gmailMessageId === emailId);
  if (!message || !message.from || !message.subject) return undefined;
  return {
    id: message.gmailMessageId,
    from: message.from,
    subject: message.subject,
    body: message.snippet ?? "",
    receivedAt: message.internalDate,
    expectedCategory: "how-to" as const,
    expectedRisk: "medium" as const,
    expectedHandling: "human_review",
    requiresTask1Evidence: true,
    heldOut: false,
    importantFacts: [],
    expectedEvidence: [],
    expectedOutcome: "review",
  };
}
const complaintAnalyzer = configuredComplaintAnalyzer();
function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function ensureGmailCredentials(ownerId: string, requireSendScope = false): Promise<void> {
  const credentials = await gmailOAuth.credentials(ownerId, requireSendScope ? "https://www.googleapis.com/auth/gmail.send" : undefined);
  if (!credentials) throw new Error("Gmail account is not connected");
  gmail.setCredentials(credentials.accessToken, credentials.userId);
}

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (body.length > 1_000_000) throw new Error("request body is too large");
  const value: unknown = body ? JSON.parse(body) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as Record<string, unknown>;
}

function send(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { status: "ok", service: "task2-inbox-agent" });
    return;
  }
  const isAuthCallback = request.url?.startsWith("/v1/auth/callback") ?? false;
  const isOAuthCallback = request.url?.startsWith("/v1/gmail/oauth/callback") ?? false;
  if (request.method === "GET" && request.url === "/v1/auth/session") {
    try {
      const principal = authenticateRequest(request);
      send(response, 200, { authenticated: true, subject: principal.subject, expiresAt: principal.expiresAt, providerConfigured: oidcConfigured(oidcConfig) });
    } catch (error: unknown) {
      send(response, 200, { authenticated: false, providerConfigured: oidcConfigured(oidcConfig), error: error instanceof Error ? error.message : "authentication required" });
    }
    return;
  }
  if (request.method === "GET" && request.url === "/v1/auth/login") {
    if (!oidcConfig) { send(response, 503, { error: "identity_provider_not_configured", message: "Google OIDC is not configured on this server." }); return; }
    if (!process.env.TASK2_AUTH_SIGNING_SECRET?.trim() || process.env.TASK2_AUTH_SIGNING_SECRET.startsWith("replace-with-")) { send(response, 503, { error: "session_signing_secret_not_configured", message: "TASK2_AUTH_SIGNING_SECRET is not configured on this server." }); return; }
    const login = createLogin(oidcConfig);
    response.writeHead(302, { location: login.url, "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "GET" && isAuthCallback) {
    if (!oidcConfig) { response.writeHead(302, { location: `${process.env.FRONTEND_URL ?? "http://127.0.0.1:5173"}/?auth_error=identity_provider_not_configured` }); response.end(); return; }
    const params = new URL(request.url!, "http://127.0.0.1").searchParams;
    if (params.get("error")) {
      console.warn(`[oidc] provider denied login: ${params.get("error")}`);
      response.writeHead(302, { location: `${oidcConfig.frontendUrl}/?auth_error=provider_denied` });
      response.end();
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) { response.writeHead(302, { location: `${oidcConfig.frontendUrl}/?auth_error=login_callback_invalid` }); response.end(); return; }
    try {
      const principal = await completeLogin(oidcConfig, code, state);
      response.writeHead(302, { location: oidcConfig.frontendUrl, "set-cookie": sessionCookie(principal), "cache-control": "no-store" });
    } catch (error: unknown) {
      const reason = error instanceof OidcAuthenticationError ? error.message.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 120) : "unexpected identity provider error";
      console.warn(`[oidc] callback failed: ${reason}`);
      response.writeHead(302, { location: `${oidcConfig.frontendUrl}/?auth_error=${encodeURIComponent(reason)}` });
    }
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/v1/auth/logout") {
    response.writeHead(200, { "content-type": "application/json", "set-cookie": clearSessionCookie() });
    response.end(JSON.stringify({ authenticated: false }));
    return;
  }
  let ownerId: string;
  if (isOAuthCallback) {
    ownerId = "";
  } else {
    try {
      const principal = authenticateRequest(request);
      ownerId = principal.subject;
    } catch (error: unknown) {
      send(response, 401, { error: "authentication_required", message: error instanceof AuthenticationError ? error.message : "authentication required" });
      return;
    }
  }
  if (request.method === "GET" && request.url === "/v1/gmail/status") {
    const token = gmailOAuth.get(ownerId);
    send(response, 200, { configured: gmailOAuth.configured(), connected: Boolean(token), account: token?.emailAddress || null, liveSendEnabled: process.env.GMAIL_LIVE_SEND_ENABLED === "true", testMode: process.env.GMAIL_LIVE_SEND_ENABLED !== "true" });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/gmail/oauth/start") {
    try {
      send(response, 200, { authorizationUrl: gmailOAuth.start(ownerId) });
    } catch (error: unknown) {
      send(response, error instanceof OAuthConfigurationError ? 503 : 400, { error: error instanceof Error ? error.message : "oauth_start_failed" });
    }
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/gmail/oauth/callback")) {
    const params = new URL(request.url, "http://127.0.0.1").searchParams;
    const error = params.get("error");
    if (error) {
      send(response, 400, { error: "oauth_denied", message: `Google authorization was not completed: ${error}` });
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      send(response, 400, { error: "oauth_callback_invalid", message: "Google callback requires code and state" });
      return;
    }
    gmailOAuth.callback(code, state).then(async (token) => {
      const identityClient = new GmailClient({ accessToken: token.accessToken, userId: "me" });
      const profile = await identityClient.profile();
      gmailOAuth.setEmail(token.ownerId, profile.emailAddress);
      gmail.setCredentials(token.accessToken, "me");
      send(response, 200, { connected: true, account: profile.emailAddress });
    }).catch((reason: unknown) => send(response, 400, { error: reason instanceof Error ? reason.message : "oauth_callback_failed" }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/gmail/disconnect") {
    gmailOAuth.disconnect(ownerId);
    gmail.clearCredentials();
    send(response, 200, { connected: false });
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/gmail/messages") && !request.url.startsWith("/v1/gmail/messages/local")) {
    const query = new URL(request.url, "http://127.0.0.1").searchParams.get("q") ?? "";
    ensureGmailCredentials(ownerId).then(() => gmail.listMessages(query)).then((messages) => send(response, 200, { messages })).catch((error: unknown) => send(response, 503, { error: error instanceof Error ? error.message : "gmail_unavailable" }));
    return;
  }
  if (request.method === "GET" && request.url === "/v1/gmail/sync/status") {
    const state = syncStore.state(ownerId);
    send(response, 200, { ...state, messages: syncStore.messages(ownerId).length });
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/gmail/messages/local")) {
    const params = new URL(request.url, "http://127.0.0.1").searchParams;
    try {
      const limit = Number(params.get("limit") ?? "50");
      const offset = Number(params.get("offset") ?? "0");
      send(response, 200, { messages: syncStore.messages(ownerId, limit, offset), sync: syncStore.state(ownerId) });
    } catch (error: unknown) {
      send(response, 400, { error: error instanceof Error ? error.message : "invalid_message_pagination" });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/v1/gmail/sync") {
    syncStore.runExclusive(ownerId, async () => {
      await ensureGmailCredentials(ownerId, true);
      const cursor = syncStore.state(ownerId).nextPageToken;
      let page;
      try {
        page = await gmail.listMessagesPage("", 100, cursor);
      } catch (error: unknown) {
        if (!cursor || !(error instanceof Error) || !error.message.includes("(400)")) throw error;
        syncStore.setPageToken(ownerId, undefined);
        page = await gmail.listMessagesPage("", 100);
      }
      let imported = 0;
      for (const summary of page.messages) {
        if (!summary.id) continue;
        const message = await gmail.getMessage(summary.id);
        if (syncStore.upsert({
          ownerId,
          gmailMessageId: message.id ?? summary.id,
          threadId: message.threadId,
          from: message.from,
          to: message.to,
          subject: message.subject,
          snippet: message.snippet,
          internalDate: message.internalDate,
          labelIds: message.labelIds ?? [],
          body: message.body,
          syncedAt: new Date().toISOString(),
        })) imported += 1;
      }
      syncStore.setPageToken(ownerId, page.nextPageToken);
      return imported;
    }).then((imported) => send(response, 200, { imported, sync: syncStore.state(ownerId) }))
      .catch((error: unknown) => send(response, 503, { error: error instanceof Error ? error.message : "gmail_sync_failed", sync: syncStore.state(ownerId) }));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/complaints/")) {
    const messageId = decodeURIComponent(request.url.slice("/v1/complaints/".length));
    const record = draftStore.complaint(ownerId, messageId);
    if (!record) return send(response, 404, { error: "complaint_not_found" });
    return send(response, 200, { complaint: record });
  }
  if (request.method === "POST" && request.url?.startsWith("/v1/complaints/") && request.url.endsWith("/analyze")) {
    const messageId = decodeURIComponent(request.url.slice("/v1/complaints/".length, -"/analyze".length));
    const message = syncStore.messages(ownerId, 500, 0).find((item) => item.gmailMessageId === messageId);
    if (!message || !message.from || !message.subject) return send(response, 404, { error: "gmail_message_not_found" });
    const now = new Date().toISOString();
    draftStore.saveComplaint({ ownerId, messageId, sender: message.from, subject: message.subject, receivedAt: message.internalDate ?? null, body: message.body ?? message.snippet ?? "", status: "processing", analysis: null, error: null, updatedAt: now });
    try {
      const analysis = await complaintAnalyzer.analyze({ sender: message.from, subject: message.subject, receivedAt: message.internalDate, body: message.body ?? message.snippet ?? "" });
      const draft = {
        emailId: messageId,
        classification: { category: "complaint" as const, subcategory: analysis.category, urgency: analysis.urgency === "critical" || analysis.urgency === "high" ? "high" as const : "normal" as const, risk: analysis.urgency === "critical" ? "critical" as const : "high" as const, productKnowledgeRequired: false, humanReviewRequired: true, promptVersion: "complaint-ai-v1" },
        requestSummary: analysis.summary, suggestedReply: analysis.reply, evidence: [], risk: "high" as const, humanApprovalRequired: true, nextAction: "human_review", promptVersion: "complaint-ai-v1", evidenceStatus: "insufficient" as const, generatedAt: now, modelVersion: process.env.GEMINI_MODEL ?? process.env.CLAUDE_MODEL, recipient: message.from, subject: `Re: ${message.subject}`,
      };
      const storedDraft = draftStore.saveGenerated(ownerId, draft, gmailOAuth.get(ownerId)?.emailAddress ?? null, now);
      const complaint = draftStore.saveComplaint({ ownerId, messageId, sender: message.from, subject: message.subject, receivedAt: message.internalDate ?? null, body: message.body ?? message.snippet ?? "", status: "analyzed", analysis, error: null, updatedAt: now });
      return send(response, 200, { complaint, draft: storedDraft.draft, version: storedDraft.version, reviewStatus: storedDraft.reviewStatus });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "complaint_analysis_failed";
      const complaint = draftStore.saveComplaint({ ownerId, messageId, sender: message.from, subject: message.subject, receivedAt: message.internalDate ?? null, body: message.body ?? message.snippet ?? "", status: "failed", analysis: null, error: detail, updatedAt: new Date().toISOString() });
      return send(response, error instanceof AiConfigurationError ? 503 : 502, { error: "complaint_analysis_failed", message: detail, complaint });
    }
  }
  if (request.method === "POST" && request.url === "/v1/gmail/send") {
    readJson(request).then(async (input) => {
      const email = syncedEmail(ownerId, input.emailId);
      const stored = typeof input.emailId === "string" ? draftStore.current(ownerId, input.emailId) : undefined;
      const draft = stored?.draft;
      if (!email || !stored || !draft) return send(response, 400, { error: "approved_draft_required" });
      const dryRun = input.dryRun !== false;
      if (stored.reviewStatus !== "approved") return send(response, 409, { error: "human_approval_required" });
      if (!draft.recipient?.trim() || !validEmail(draft.recipient) || !draft.subject?.trim() || !draft.suggestedReply.trim()) return send(response, 400, { error: "invalid_draft_content" });
      if (dryRun || process.env.GMAIL_LIVE_SEND_ENABLED !== "true") {
        draftStore.recordBlocked(ownerId, email.id, new Date().toISOString(), "live sending is disabled; preview only");
        const result = await gmail.sendMessage({ to: draft.recipient, subject: draft.subject, body: draft.suggestedReply }, true);
        return send(response, 200, { result, testMode: true, blocked: !dryRun });
      }
      const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim()
        : request.headers["idempotency-key"]?.toString();
      if (!idempotencyKey) return send(response, 400, { error: "idempotency_key_required" });
      const account = gmailOAuth.get(ownerId)?.emailAddress ?? null;
      const attempt = draftStore.claimSend(ownerId, email.id, idempotencyKey, account, new Date().toISOString());
      if (attempt.status !== "sending") return send(response, 409, { error: "send_attempt_already_recorded", attempt });
      try {
        await ensureGmailCredentials(ownerId);
        const result = await gmail.sendMessage({ to: draft.recipient, subject: draft.subject, body: draft.suggestedReply }, false);
        const completed = draftStore.completeSend(idempotencyKey, result.accepted ? "sent" : "outcome_unknown", new Date().toISOString(), result.accepted ? undefined : "gmail_outcome_unknown", result.accepted ? undefined : "Gmail returned no provider message ID", result.messageId);
        return send(response, result.accepted ? 200 : 503, { result, attempt: completed, testMode: false });
      } catch (error: unknown) {
        const completed = draftStore.completeSend(idempotencyKey, "outcome_unknown", new Date().toISOString(), "gmail_outcome_unknown", error instanceof Error ? error.message : "gmail_send_failed");
        return send(response, 503, { error: "gmail_send_outcome_unknown", attempt: completed });
      }
    }).catch((error: unknown) => send(response, 503, { error: error instanceof Error ? error.message : "gmail_send_failed" }));
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/v1/gmail/send-attempts/") && request.url.endsWith("/reconcile")) {
    void (async () => {
      const idempotencyKey = request.url!.slice("/v1/gmail/send-attempts/".length, -"/reconcile".length);
      const attempt = draftStore.attempt(idempotencyKey);
      if (!attempt) return send(response, 404, { error: "send_attempt_not_found" });
      if (attempt.status !== "outcome_unknown") return send(response, 409, { error: "send_attempt_not_reconcilable", attempt });
      if (!attempt.providerMessageId) {
        return send(response, 409, { error: "outcome_unknown", message: "Gmail did not provide a message ID; manual reconciliation evidence is required.", attempt });
      }
      const stored = draftStore.current(ownerId, attempt.emailId);
      if (!stored || stored.version !== attempt.version) return send(response, 409, { error: "draft_version_not_found" });
      try {
        await ensureGmailCredentials(ownerId);
        const message = await gmail.getMessage(attempt.providerMessageId);
        const matches = message.to?.trim().toLowerCase() === stored.draft.recipient?.trim().toLowerCase()
          && message.subject?.trim() === stored.draft.subject?.trim();
        if (!matches) return send(response, 409, { error: "outcome_unknown", message: "Provider message evidence does not match the approved draft.", attempt });
        const resolved = draftStore.resolveOutcome(idempotencyKey, "sent", new Date().toISOString(), attempt.providerMessageId);
        return send(response, 200, { attempt: resolved, reconciled: true });
      } catch (error: unknown) {
        send(response, 503, { error: "reconciliation_unavailable", message: error instanceof Error ? error.message : "Gmail evidence could not be retrieved", attempt });
      }
    })();
    return;
  }
  if (request.method === "POST" && (request.url === "/v1/smoke/draft" || request.url === "/v1/drafts")) {
    readJson(request).then(async (input) => {
      const isSmokeRequest = request.url === "/v1/smoke/draft" || request.headers["x-request-id"] === "smoke-request";
      const email = isSmokeRequest ? findEmail(input.emailId) : syncedEmail(ownerId, input.emailId);
      if (!email) return send(response, 404, { error: "email_not_found" });
      const requestId = request.headers["x-request-id"]?.toString() ?? `task2-${Date.now()}`;
      let knowledge;
      if (email.expectedCategory === "how-to") {
        knowledge = await queryHowToKnowledge(task1, email, requestId);
      } else {
        knowledge = await task1.query(buildKnowledgeQuestion(email), requestId);
      }
      const classification = classifyEmailDeterministically(email);
      const draft = createDraft(email, classification, knowledge);
      const stored = draftStore.saveGenerated(ownerId, draft, gmailOAuth.get(ownerId)?.emailAddress ?? null);
      send(response, 200, { draft: stored.draft, task1Status: knowledge.status, reviewStatus: stored.reviewStatus, version: stored.version });
    }).catch((error: unknown) => {
      const status = error instanceof Task1ClientError ? 503 : 400;
      send(response, status, { error: error instanceof Error ? error.message : "request_failed" });
    });
    return;
  }
  if (request.method === "POST" && request.url === "/v1/reviews") {
    readJson(request).then((input) => {
      const email = syncedEmail(ownerId, input.emailId);
      const actions: ReviewAction[] = ["approve", "save", "edit", "reject", "expert_assistance"];
      if (!email) return send(response, 404, { error: "email_not_found" });
      if (typeof input.action !== "string" || !actions.includes(input.action as ReviewAction)) return send(response, 400, { error: "emailId and a valid action are required" });
      const stored = draftStore.current(ownerId, email.id);
      const draft = stored?.draft;
      if (!stored || !draft) return send(response, 400, { error: "draft must be created before review" });
      const content = typeof input.finalContent === "string" ? input.finalContent : draft.suggestedReply;
      const event = new ReviewWorkflow(() => new Date().toISOString()).review(
        draft,
        input.action as ReviewAction,
        input.action === "save" || input.action === "edit" || input.action === "reject" ? content : undefined,
        typeof input.reason === "string" ? input.reason : undefined,
      );
      feedback.add({
        ...event,
        originalEmail: { subject: email.subject, body: email.body, from: email.from },
        category: draft.classification.category,
        risk: draft.risk,
      });
      const updated = draftStore.review(ownerId, email.id, input.action as ReviewAction, content, gmailOAuth.get(ownerId)?.emailAddress ?? null, event.createdAt, typeof input.reason === "string" ? input.reason : undefined);
      send(response, 201, { event, reviewStatus: updated.reviewStatus, finalized: updated.reviewStatus !== "pending", version: updated.version });
    }).catch((error: unknown) => {
      if (error instanceof ReviewAlreadyFinalizedError) {
        send(response, 409, { error: "review_already_finalized", message: error.message, reviewStatus: error.status });
        return;
      }
      send(response, 400, { error: error instanceof Error ? error.message : "review_failed" });
    });
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/v1/reviews/")) {
    const emailId = request.url.slice("/v1/reviews/".length);
    if (!syncedEmail(ownerId, emailId)) {
      send(response, 404, { error: "email_not_found" });
      return;
    }
    const status = draftStore.current(ownerId, emailId)?.reviewStatus ?? "pending";
    send(response, 200, { emailId, reviewStatus: status, finalized: status !== "pending" });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

process.once("SIGTERM", () => {
  server.close(() => {
    draftStore.close();
    process.exit(0);
  });
});

server.listen(port, "127.0.0.1", () => console.log(`Task 2 API listening on http://127.0.0.1:${port}`));
