export interface GmailConfig {
  accessToken?: string;
  userId?: string;
  liveSendEnabled?: boolean;
  fetcher?: typeof fetch;
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
}

export interface GmailMessagePage {
  messages: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface SendResult {
  mode: "dry-run" | "live";
  messageId: string | null;
  accepted: boolean;
  reason: string;
  preview?: Pick<GmailMessage, "to" | "subject" | "body">;
}

export class GmailClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: GmailConfig = {}) {
    this.fetcher = config.fetcher ?? fetch;
  }

  configured(): boolean {
    return Boolean(this.config.accessToken && this.config.userId);
  }

  setCredentials(accessToken: string, userId: string): void {
    this.config.accessToken = accessToken;
    this.config.userId = userId;
  }

  clearCredentials(): void {
    this.config.accessToken = undefined;
    this.config.userId = undefined;
  }

  async listMessages(query = "", maxResults = 25): Promise<GmailMessage[]> {
    const page = await this.listMessagesPage(query, maxResults);
    return page.messages;
  }

  async listMessagesPage(query = "", maxResults = 100, pageToken?: string): Promise<GmailMessagePage> {
    if (!this.configured()) throw new Error("Gmail OAuth is not configured");
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) throw new Error("maxResults must be between 1 and 500");
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await this.request(`/messages?${params.toString()}`);
    const payload = await response.json() as { messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string; resultSizeEstimate?: number };
    return {
      messages: (payload.messages ?? []).map((message) => ({ id: message.id, threadId: message.threadId })),
      nextPageToken: payload.nextPageToken,
      resultSizeEstimate: payload.resultSizeEstimate,
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    if (!this.configured()) throw new Error("Gmail OAuth is not configured");
    if (!id.trim()) throw new Error("message id is required");
    const response = await this.request(`/messages/${encodeURIComponent(id)}?format=full`);
    const payload = await response.json() as {
      id?: string;
      threadId?: string;
      labelIds?: string[];
      internalDate?: string;
      snippet?: string;
      payload?: { mimeType?: string; body?: { data?: string }; headers?: Array<{ name: string; value: string }>; parts?: unknown[] };
    };
    const headers = new Map((payload.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
    const decode = (data?: string) => data ? Buffer.from(data, "base64url").toString("utf8") : "";
    const textPart = (part: any): string => {
      if (!part || typeof part !== "object") return "";
      if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
      return Array.isArray(part.parts) ? part.parts.map(textPart).join("\n") : "";
    };
    const body = payload.payload?.body?.data ? decode(payload.payload.body.data) : textPart(payload.payload);
    return {
      id: payload.id,
      threadId: payload.threadId,
      labelIds: payload.labelIds ?? [],
      internalDate: payload.internalDate,
      snippet: payload.snippet,
      from: headers.get("from"),
      to: headers.get("to"),
      subject: headers.get("subject"),
      body,
    };
  }

  async sendMessage(message: GmailMessage, dryRun = true): Promise<SendResult> {
    if (!message.to?.trim() || !message.subject?.trim() || !message.body?.trim()) throw new Error("recipient, subject, and body are required");
    if (dryRun || !this.config.liveSendEnabled) {
      return {
        mode: "dry-run",
        messageId: null,
        accepted: true,
        reason: dryRun ? "explicit dry-run" : "live sending is disabled",
        preview: { to: message.to, subject: message.subject, body: message.body },
      };
    }
    if (!this.configured()) throw new Error("Gmail OAuth is not configured");
    const raw = [
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message.body,
    ].join("\r\n");
    const response = await this.request("/messages/send", "POST", JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId: message.threadId }));
    const payload = await response.json() as { id?: string };
    return { mode: "live", messageId: payload.id ?? null, accepted: Boolean(payload.id), reason: payload.id ? "Gmail accepted the message" : "Gmail returned no message id" };
  }

  async profile(): Promise<{ emailAddress: string }> {
    const response = await this.request("/profile");
    const payload = await response.json() as { emailAddress?: string };
    if (!payload.emailAddress) throw new Error("Gmail profile did not include an email address");
    return { emailAddress: payload.emailAddress };
  }

  private async request(path: string, method = "GET", body?: string): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.config.userId ?? "me")}${path}`, {
        method,
        headers: { authorization: "Bearer " + (this.config.accessToken ?? ""), "content-type": "application/json" },
        body,
      });
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Error(`Gmail request failed (${response.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new Error("Gmail request failed after retries");
  }
}
