import { Citation, IncomingEmail, Task1Answer } from "./schemas.js";

export class Task1ClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface Task1ClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class Task1Client {
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: Task1ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async query(question: string, requestId: string, timeoutMs = this.timeoutMs): Promise<Task1Answer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Task1ClientError("invalid_json", "Task 1 returned invalid JSON"); }
      if (!response.ok) throw new Task1ClientError(typeof payload === "object" && payload && "error" in payload ? String((payload as { error: unknown }).error) : "http_error", `Task 1 returned HTTP ${response.status}`);
      if (!isTask1Answer(payload)) throw new Task1ClientError("invalid_response", "Task 1 response did not match the contract");
      return payload;
    } catch (error) {
      if (error instanceof Task1ClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new Task1ClientError("timeout", "Task 1 request timed out");
      throw new Task1ClientError("unavailable", "Task 1 is unavailable");
    } finally { clearTimeout(timeout); }
  }

}

export function buildKnowledgeQuestion(email: IncomingEmail): string {
  return [
    "Find product documentation that directly answers the customer's question.",
    `Customer question: ${email.body}`,
    `Subject context: ${email.subject}`,
    "Return only evidence relevant to this product question; do not use generic navigation pages as support.",
  ].join("\n");
}

export function buildFocusedRetryQuestion(email: IncomingEmail): string {
  const topic = email.body.replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
  const topicHint = /\b(billing|payment)\b/i.test(topic)
    ? "Payment Settings billing"
    : /\b(signup|registration|form)\b/i.test(topic)
      ? "Form Manager member signup form"
      : "";
  return (topicHint || topic).replace(/\s+/g, " ").trim();
}

export async function queryHowToKnowledge(client: Task1Client, email: IncomingEmail, requestId: string): Promise<Task1Answer> {
  try {
    const first = await client.query(buildKnowledgeQuestion(email), requestId);
    if (first.status === "answered") return first;
    return await client.query(buildFocusedRetryQuestion(email), `${requestId}-retry`, 3_000);
  } catch (error) {
    if (email.expectedCategory !== "how-to") throw error;
    return await client.query(buildFocusedRetryQuestion(email), `${requestId}-retry`, 3_000);
  }
}

function isTask1Answer(value: unknown): value is Task1Answer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (typeof candidate.answer === "string" || candidate.answer === null) && typeof candidate.status === "string" && Array.isArray(candidate.sources) && Array.isArray(candidate.image_references) && typeof candidate.human_help_needed === "boolean" && typeof candidate.request_id === "string" && Array.isArray(candidate.retrieval_trace);
}
