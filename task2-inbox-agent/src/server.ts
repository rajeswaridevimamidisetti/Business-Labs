import { createServer } from "node:http";
import { Task1Client, Task1ClientError } from "./task1-client.js";
import { createDraft } from "./drafts.js";
import { syntheticEmails } from "./dataset.js";
import { ReviewAlreadyFinalizedError, ReviewWorkflow } from "./review.js";
import { Draft, ReviewAction, validateClassification } from "./schemas.js";

const port = Number(process.env.TASK2_PORT ?? "8002");
const task1 = new Task1Client({ baseUrl: process.env.TASK1_BASE_URL ?? "http://127.0.0.1:8001" });
const emails = syntheticEmails();
const reviews = new ReviewWorkflow();
const drafts = new Map<string, Draft>();

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

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { status: "ok", service: "task2-inbox-agent" });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/emails") {
    send(response, 200, { emails });
    return;
  }
  if (request.method === "POST" && (request.url === "/v1/smoke/draft" || request.url === "/v1/drafts")) {
    readJson(request).then(async (input) => {
      const email = emails.find((item) => item.id === input.emailId) ?? emails[0];
      if (!email) return send(response, 400, { error: "no_email_available" });
      const knowledge = await task1.query(email.body, request.headers["x-request-id"]?.toString() ?? `task2-${Date.now()}`);
      const classification = validateClassification({
        category: email.expectedCategory,
        subcategory: "synthetic",
        urgency: email.expectedRisk === "high" ? "high" : "normal",
        risk: email.expectedRisk,
        productKnowledgeRequired: email.requiresTask1Evidence,
        humanReviewRequired: email.expectedRisk !== "low",
        promptVersion: "smoke-v1",
      });
      const draft = createDraft(email, classification, knowledge);
      drafts.set(email.id, draft);
      send(response, 200, { draft, task1Status: knowledge.status, reviewStatus: reviews.status(email.id) });
    }).catch((error: unknown) => {
      const status = error instanceof Task1ClientError ? 503 : 400;
      send(response, status, { error: error instanceof Error ? error.message : "request_failed" });
    });
    return;
  }
  if (request.method === "POST" && request.url === "/v1/reviews") {
    readJson(request).then((input) => {
      const email = emails.find((item) => item.id === input.emailId);
      const actions: ReviewAction[] = ["approve", "save", "edit", "reject", "expert_assistance"];
      if (!email || typeof input.action !== "string" || !actions.includes(input.action as ReviewAction)) return send(response, 400, { error: "emailId and a valid action are required" });
      const draft = drafts.get(email.id);
      if (!draft) return send(response, 400, { error: "draft must be created before review" });
      const content = typeof input.finalContent === "string" ? input.finalContent : draft.suggestedReply;
      const event = reviews.review(
        draft,
        input.action as ReviewAction,
        input.action === "save" || input.action === "edit" || input.action === "reject" ? content : undefined,
        typeof input.reason === "string" ? input.reason : undefined,
      );
      if (input.action === "save") drafts.set(email.id, { ...draft, suggestedReply: content });
      send(response, 201, { event, reviewStatus: reviews.status(email.id), finalized: reviews.status(email.id) !== "pending" });
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
    if (!emails.some((item) => item.id === emailId)) {
      send(response, 404, { error: "email_not_found" });
      return;
    }
    send(response, 200, { emailId, reviewStatus: reviews.status(emailId), finalized: reviews.status(emailId) !== "pending" });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => console.log(`Task 2 API listening on http://127.0.0.1:${port}`));
