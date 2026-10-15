import { createServer } from "node:http";
import { Task1Client, Task1ClientError } from "./task1-client.js";
import { createDraft } from "./drafts.js";
import { syntheticEmails } from "./dataset.js";

const port = Number(process.env.TASK2_PORT ?? "8002");
const task1 = new Task1Client({ baseUrl: process.env.TASK1_BASE_URL ?? "http://127.0.0.1:8001" });

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "task2-inbox-agent" }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/smoke/draft") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body) as { emailId?: string };
        const email = syntheticEmails().find((item) => item.id === input.emailId) ?? syntheticEmails()[0];
        const knowledge = await task1.query(email.body, request.headers["x-request-id"]?.toString() ?? `task2-${Date.now()}`);
        const classification = { category: email.expectedCategory, subcategory: "synthetic", urgency: email.expectedRisk === "high" ? "high" : "normal", risk: email.expectedRisk, productKnowledgeRequired: email.requiresTask1Evidence, humanReviewRequired: email.expectedRisk !== "low", promptVersion: "smoke-v1" } as const;
        const draft = createDraft(email, classification, knowledge);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ draft, task1Status: knowledge.status }));
      } catch (error) {
        const status = error instanceof Task1ClientError ? 503 : 400;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "smoke_failed" }));
      }
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => console.log(`Task 2 API listening on http://127.0.0.1:${port}`));
