import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Draft, ReviewAction, ReviewStatus } from "./schemas.js";

export interface StoredDraft {
  draft: Draft;
  version: number;
  account: string | null;
  reviewStatus: ReviewStatus;
  approvalHash: string | null;
}

export interface SendAttempt {
  idempotencyKey: string;
  emailId: string;
  version: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  providerMessageId: string | null;
}

export interface ComplaintRecord {
  ownerId: string;
  messageId: string;
  sender: string;
  subject: string;
  receivedAt: string | null;
  body: string;
  status: "pending" | "processing" | "analyzed" | "failed";
  analysis: unknown | null;
  error: string | null;
  updatedAt: string;
}

export class DraftStore {
  private readonly db: DatabaseSync;

  constructor(databaseUrl = process.env.TASK2_DATABASE_URL ?? "sqlite://data/local/task2.sqlite3") {
    const filePath = databaseUrl.startsWith("sqlite://") ? databaseUrl.slice("sqlite://".length) : databaseUrl;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.recoverInterruptedAttempts();
  }

  close(): void { this.db.close(); }

  saveGenerated(ownerId: string, draft: Draft, account: string | null, now = new Date().toISOString()): StoredDraft {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM email_drafts WHERE owner_id = ? AND email_id = ?").get(ownerId, draft.emailId) as { version: number };
      const version = Number(current.version) + 1;
      this.db.prepare(
        `INSERT INTO email_drafts
          (owner_id, email_id, version, payload_json, recipient, subject, body, gmail_account,
           review_status, approval_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      ).run(ownerId, draft.emailId, version, JSON.stringify(draft), draft.recipient ?? null, draft.subject ?? null, draft.suggestedReply, account, now, now);
      this.audit(ownerId, draft.emailId, version, "draft_generated", now, { account });
      return this.readCurrent(ownerId, draft.emailId)!;
    });
  }

  current(ownerId: string, emailId: string): StoredDraft | undefined {
    return this.readCurrent(ownerId, emailId) ?? undefined;
  }

  review(ownerId: string, emailId: string, action: ReviewAction, content: string, account: string | null, now: string, reason?: string): StoredDraft {
    return this.transaction(() => {
      const current = this.readCurrent(ownerId, emailId);
      if (!current) throw new Error("draft must be created before review");
      const changed = content !== current.draft.suggestedReply;
      let version = current.version;
      if (action === "save" || action === "edit" || changed) {
        version += 1;
        const updated = { ...current.draft, suggestedReply: content, generatedAt: current.draft.generatedAt ?? now };
        this.db.prepare(
          `INSERT INTO email_drafts
            (owner_id, email_id, version, payload_json, recipient, subject, body, gmail_account,
             review_status, approval_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(ownerId, emailId, version, JSON.stringify(updated), updated.recipient ?? null, updated.subject ?? null, content, account,
          action === "approve" ? "approved" : "pending", action === "approve" ? this.hash(ownerId, account, updated, content) : null, now, now);
      } else if (action === "approve") {
        const hash = this.hash(ownerId, account, current.draft, content);
        this.db.prepare("UPDATE email_drafts SET review_status = 'approved', approval_hash = ?, gmail_account = ?, updated_at = ? WHERE owner_id = ? AND email_id = ? AND version = ?")
          .run(hash, account, now, ownerId, emailId, version);
      } else if (action === "reject" || action === "expert_assistance") {
        this.db.prepare("UPDATE email_drafts SET review_status = ?, approval_hash = NULL, updated_at = ? WHERE owner_id = ? AND email_id = ? AND version = ?")
          .run(action === "reject" ? "rejected" : "expert_assistance", now, ownerId, emailId, version);
      }
      this.audit(ownerId, emailId, version, `review_${action}`, now, { reason });
      return this.readCurrent(ownerId, emailId)!;
    });
  }

  claimSend(ownerId: string, emailId: string, idempotencyKey: string, account: string | null, now: string): SendAttempt {
    return this.transaction(() => {
      const current = this.readCurrent(ownerId, emailId);
      if (!current || current.reviewStatus !== "approved" || !current.approvalHash) throw new Error("human approval required");
      const expected = this.hash(ownerId, account, current.draft, current.draft.suggestedReply);
      if (current.account !== account || current.approvalHash !== expected) throw new Error("approval invalidated");
      const existing = this.db.prepare("SELECT * FROM send_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return this.mapAttempt(existing);
      const prior = this.db.prepare("SELECT * FROM send_attempts WHERE owner_id = ? AND email_id = ? AND draft_version = ? AND status IN ('sending', 'sent', 'outcome_unknown')").get(ownerId, emailId, current.version);
      if (prior) throw new Error("send attempt already recorded");
      this.db.prepare(
        `INSERT INTO send_attempts
          (idempotency_key, owner_id, email_id, draft_version, status, created_at)
         VALUES (?, ?, ?, ?, 'sending', ?)`,
      ).run(idempotencyKey, ownerId, emailId, current.version, now);
      this.audit(ownerId, emailId, current.version, "send_claimed", now, { idempotencyKey });
      return this.mapAttempt(this.db.prepare("SELECT * FROM send_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown>);
    });
  }

  completeSend(idempotencyKey: string, status: "sent" | "outcome_unknown" | "failed", now: string, errorCode?: string, errorDetail?: string, providerMessageId?: string | null): SendAttempt {
    return this.transaction(() => {
      this.db.prepare("UPDATE send_attempts SET status = ?, completed_at = ?, error_code = ?, error_detail = ?, provider_message_id = COALESCE(?, provider_message_id) WHERE idempotency_key = ? AND status = 'sending'")
        .run(status, now, errorCode ?? null, errorDetail?.slice(0, 500) ?? null, providerMessageId ?? null, idempotencyKey);
      return this.mapAttempt(this.db.prepare("SELECT * FROM send_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown>);
    });
  }

  attempt(idempotencyKey: string): SendAttempt | undefined {
    const row = this.db.prepare("SELECT * FROM send_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? this.mapAttempt(row) : undefined;
  }

  resolveOutcome(idempotencyKey: string, outcome: "sent" | "failed", now: string, providerMessageId?: string): SendAttempt {
    return this.transaction(() => {
      const current = this.attempt(idempotencyKey);
      if (!current) throw new Error("send attempt not found");
      if (current.status !== "outcome_unknown") throw new Error("send attempt is not awaiting reconciliation");
      this.db.prepare("UPDATE send_attempts SET status = ?, completed_at = ?, error_code = NULL, error_detail = NULL, provider_message_id = COALESCE(?, provider_message_id) WHERE idempotency_key = ? AND status = 'outcome_unknown'")
        .run(outcome, now, providerMessageId ?? null, idempotencyKey);
      return this.mapAttempt(this.db.prepare("SELECT * FROM send_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown>);
    });
  }

  recordBlocked(ownerId: string, emailId: string, now: string, detail: string): void {
    this.transaction(() => {
      const current = this.readCurrent(ownerId, emailId);
      this.audit(ownerId, emailId, current?.version ?? null, "send_blocked", now, { detail });
    });
  }

  complaint(ownerId: string, messageId: string): ComplaintRecord | undefined {
    const row = this.db.prepare("SELECT * FROM complaint_records WHERE owner_id = ? AND message_id = ?").get(ownerId, messageId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { ownerId: String(row.owner_id), messageId: String(row.message_id), sender: String(row.sender), subject: String(row.subject), receivedAt: row.received_at ? String(row.received_at) : null, body: String(row.body), status: String(row.status) as ComplaintRecord["status"], analysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : null, error: row.error_detail ? String(row.error_detail) : null, updatedAt: String(row.updated_at) };
  }

  saveComplaint(record: Omit<ComplaintRecord, "updatedAt"> & { updatedAt?: string }): ComplaintRecord {
    const now = record.updatedAt ?? new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO complaint_records
        (owner_id, message_id, sender, subject, received_at, body, status, analysis_json, error_detail, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, message_id) DO UPDATE SET sender=excluded.sender, subject=excluded.subject,
        received_at=excluded.received_at, body=excluded.body, status=excluded.status,
        analysis_json=excluded.analysis_json, error_detail=excluded.error_detail, updated_at=excluded.updated_at`)
        .run(record.ownerId, record.messageId, record.sender, record.subject, record.receivedAt, record.body, record.status, record.analysis ? JSON.stringify(record.analysis) : null, record.error, now);
      this.audit(record.ownerId, record.messageId, null, "complaint_updated", now, { status: record.status });
    });
    return this.complaint(record.ownerId, record.messageId)!;
  }

  private hash(ownerId: string, account: string | null, draft: Draft, body: string): string {
    return createHash("sha256").update(JSON.stringify({
      ownerId,
      account,
      recipient: draft.recipient?.trim().toLowerCase() ?? "",
      subject: draft.subject?.trim() ?? "",
      body,
    })).digest("hex");
  }

  private readCurrent(ownerId: string, emailId: string): StoredDraft | null {
    const row = this.db.prepare("SELECT * FROM email_drafts WHERE owner_id = ? AND email_id = ? ORDER BY version DESC LIMIT 1").get(ownerId, emailId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      draft: JSON.parse(String(row.payload_json)) as Draft,
      version: Number(row.version),
      account: row.gmail_account ? String(row.gmail_account) : null,
      reviewStatus: String(row.review_status) as ReviewStatus,
      approvalHash: row.approval_hash ? String(row.approval_hash) : null,
    };
  }

  private audit(ownerId: string, emailId: string, version: number | null, type: string, now: string, details: unknown): void {
    this.db.prepare("INSERT INTO draft_audit_events (owner_id, email_id, draft_version, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ownerId, emailId, version, type, JSON.stringify(details), now);
  }

  private mapAttempt(row: Record<string, unknown>): SendAttempt {
    return {
      idempotencyKey: String(row.idempotency_key),
      emailId: String(row.email_id),
      version: Number(row.draft_version),
      status: String(row.status),
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
      errorDetail: row.error_detail ? String(row.error_detail) : null,
      providerMessageId: row.provider_message_id ? String(row.provider_message_id) : null,
    };
  }

  private recoverInterruptedAttempts(): void {
    this.db.prepare("UPDATE send_attempts SET status = 'outcome_unknown', completed_at = COALESCE(completed_at, ?), error_code = 'process_restart', error_detail = 'Send outcome requires reconciliation after process restart' WHERE status = 'sending'")
      .run(new Date().toISOString());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_drafts (
        owner_id TEXT NOT NULL, email_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload_json TEXT NOT NULL, recipient TEXT, subject TEXT, body TEXT NOT NULL,
        gmail_account TEXT, review_status TEXT NOT NULL, approval_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, email_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_email_drafts_current ON email_drafts(owner_id, email_id, version DESC);
      CREATE TABLE IF NOT EXISTS draft_audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, email_id TEXT NOT NULL,
        draft_version INTEGER, event_type TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_draft_audit_owner_email ON draft_audit_events(owner_id, email_id, created_at);
      CREATE TABLE IF NOT EXISTS send_attempts (
        idempotency_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, email_id TEXT NOT NULL,
        draft_version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        completed_at TEXT, error_code TEXT, error_detail TEXT, provider_message_id TEXT,
        UNIQUE (owner_id, email_id, draft_version, status)
      );
      CREATE INDEX IF NOT EXISTS idx_send_attempts_owner_email ON send_attempts(owner_id, email_id, created_at);
      CREATE TABLE IF NOT EXISTS complaint_records (
        owner_id TEXT NOT NULL, message_id TEXT NOT NULL, sender TEXT NOT NULL,
        subject TEXT NOT NULL, received_at TEXT, body TEXT NOT NULL,
        status TEXT NOT NULL, analysis_json TEXT, error_detail TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_complaints_owner_status ON complaint_records(owner_id, status, updated_at);
    `);
    const columns = this.db.prepare("PRAGMA table_info(send_attempts)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "provider_message_id")) this.db.exec("ALTER TABLE send_attempts ADD COLUMN provider_message_id TEXT");
    const migration = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get();
    if (!migration) this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
