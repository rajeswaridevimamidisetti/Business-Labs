import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftStore } from "../src/draft-store.js";
import type { Draft } from "../src/schemas.js";

const draft: Draft = {
  emailId: "email-store-1",
  classification: {
    category: "how-to",
    subcategory: "support",
    urgency: "normal",
    risk: "low",
    productKnowledgeRequired: true,
    humanReviewRequired: true,
    promptVersion: "test",
  },
  requestSummary: "A supported request",
  suggestedReply: "Original response",
  evidence: [],
  risk: "low",
  humanApprovalRequired: true,
  nextAction: "review",
  promptVersion: "test",
  recipient: "member@example.com",
  subject: "Re: Support request",
};

function temporaryDatabase(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "task2-draft-store-"));
  const path = join(directory, "task2.sqlite3");
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("approval survives closing and reopening the application store", () => {
  const database = temporaryDatabase();
  const first = new DraftStore(`sqlite://${database.path}`);
  first.saveGenerated("owner-1", draft, "member@example.com", "2026-01-01T00:00:00.000Z");
  const approved = first.review("owner-1", draft.emailId, "approve", draft.suggestedReply, "member@example.com", "2026-01-01T00:01:00.000Z");
  assert.equal(approved.reviewStatus, "approved");
  first.close();

  const restarted = new DraftStore(`sqlite://${database.path}`);
  assert.equal(restarted.current("owner-1", draft.emailId)?.reviewStatus, "approved");
  restarted.close();
  database.cleanup();
});

test("editing a draft creates a new version and invalidates approval", () => {
  const store = new DraftStore(":memory:");
  store.saveGenerated("owner-1", draft, "member@example.com");
  store.review("owner-1", draft.emailId, "approve", draft.suggestedReply, "member@example.com", new Date().toISOString());
  const edited = store.review("owner-1", draft.emailId, "edit", "Edited response", "member@example.com", new Date().toISOString());
  assert.equal(edited.version, 2);
  assert.equal(edited.reviewStatus, "pending");
  assert.equal(edited.approvalHash, null);
  store.close();
});

test("concurrent claims allow only one durable send attempt", async () => {
  const store = new DraftStore(":memory:");
  store.saveGenerated("owner-1", draft, "member@example.com");
  store.review("owner-1", draft.emailId, "approve", draft.suggestedReply, "member@example.com", new Date().toISOString());
  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.claimSend("owner-1", draft.emailId, "key-a", "member@example.com", new Date().toISOString())),
    Promise.resolve().then(() => store.claimSend("owner-1", draft.emailId, "key-b", "member@example.com", new Date().toISOString())),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  store.close();
});

test("an interrupted send is recovered as ambiguous and cannot be retried blindly", () => {
  const database = temporaryDatabase();
  const first = new DraftStore(`sqlite://${database.path}`);
  first.saveGenerated("owner-1", draft, "member@example.com");
  first.review("owner-1", draft.emailId, "approve", draft.suggestedReply, "member@example.com", new Date().toISOString());
  first.claimSend("owner-1", draft.emailId, "key-a", "member@example.com", new Date().toISOString());
  first.close();

  const restarted = new DraftStore(`sqlite://${database.path}`);
  assert.equal((restarted.attempt("key-a")?.status), "outcome_unknown");
  assert.throws(
    () => restarted.claimSend("owner-1", draft.emailId, "key-b", "member@example.com", new Date().toISOString()),
    /send attempt already recorded/,
  );
  restarted.close();
  database.cleanup();
});

test("outcome_unknown requires explicit reconciliation before it becomes sent", () => {
  const store = new DraftStore(":memory:");
  store.saveGenerated("owner-1", draft, "member@example.com");
  store.review("owner-1", draft.emailId, "approve", draft.suggestedReply, "member@example.com", new Date().toISOString());
  store.claimSend("owner-1", draft.emailId, "key-reconcile", "member@example.com", new Date().toISOString());
  store.completeSend("key-reconcile", "outcome_unknown", new Date().toISOString(), "timeout_after_possible_acceptance", "provider response was not received", "provider-message-1");
  assert.throws(() => store.claimSend("owner-1", draft.emailId, "key-retry", "member@example.com", new Date().toISOString()), /send attempt already recorded/);
  const resolved = store.resolveOutcome("key-reconcile", "sent", new Date().toISOString(), "provider-message-1");
  assert.equal(resolved.status, "sent");
  store.close();
});

test("complaint analysis and original message persist across restart", () => {
  const database = temporaryDatabase();
  const first = new DraftStore(`sqlite://${database.path}`);
  first.saveComplaint({
    ownerId: "owner-1",
    messageId: "gmail-1",
    sender: "customer@example.com",
    subject: "Service complaint",
    receivedAt: "2026-01-01T00:00:00.000Z",
    body: "The service failed twice.",
    status: "analyzed",
    analysis: { summary: "Repeated failure", urgency: "high" },
    error: null,
  });
  first.close();
  const restarted = new DraftStore(`sqlite://${database.path}`);
  const complaint = restarted.complaint("owner-1", "gmail-1");
  assert.equal(complaint?.body, "The service failed twice.");
  assert.equal((complaint?.analysis as { urgency: string }).urgency, "high");
  restarted.close();
  database.cleanup();
});
