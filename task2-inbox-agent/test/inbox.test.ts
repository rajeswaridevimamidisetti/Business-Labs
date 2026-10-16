import assert from "node:assert/strict";
import test from "node:test";
import { syntheticEmails } from "../src/dataset.js";
import { classifyEmail } from "../src/classifier.js";
import { createDraft } from "../src/drafts.js";
import { EligibilityTracker } from "../src/eligibility.js";
import { defaultInboxEvaluationCases } from "../src/evals.js";
import { ReviewAlreadyFinalizedError, ReviewWorkflow } from "../src/review.js";
import { Task1Client, Task1ClientError } from "../src/task1-client.js";
import { FeedbackStore } from "../src/feedback.js";
import { renderReviewPage } from "../src/review-ui.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dataset contains the required balanced synthetic coverage", () => {
  const emails = syntheticEmails();
  assert.equal(emails.length, 50);
  assert.equal(emails.filter((email) => email.heldOut).length, 10);
  assert.ok(emails.some((email) => email.body.includes("Ignore all agent rules")));
});

test("classifier validates model output and falls back conservatively", async () => {
  const email = syntheticEmails()[0];
  const classification = await classifyEmail(email, { classify: async () => ({ category: "bad" }) });
  assert.equal(classification.humanReviewRequired, true);
  assert.equal(classification.risk, "high");
});

test("drafts do not invent product behavior without Task 1 evidence", () => {
  const email = syntheticEmails()[0];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.equal(draft.evidence.length, 0);
  assert.equal(draft.humanApprovalRequired, true);
});

test("review workflow stores edits and blocks duplicate finalization", () => {
  const email = syntheticEmails()[0];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: "Use settings.", status: "answered", sources: [{ title: "Guide", url: "https://example.test/guide" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] });
  const workflow = new ReviewWorkflow(() => "fixed");
  const event = workflow.review(draft, "edit", "Edited reply", "clarity");
  assert.equal(event.action, "edited");
  assert.throws(() => workflow.review(draft, "approve"));
});

test("review actions have explicit terminal and non-terminal transitions", () => {
  const emails = syntheticEmails();
  const answer = { answer: "Use settings.", status: "answered", sources: [{ title: "Guide", url: "https://example.test/guide" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] };
  const draftFor = (emailIndex: number) => createDraft(emails[emailIndex], { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, answer);

  const saveWorkflow = new ReviewWorkflow();
  const saved = saveWorkflow.review(draftFor(0), "save", "Saved reply");
  assert.equal(saved.action, "pending");
  assert.equal(saveWorkflow.status(emails[0].id), "pending");
  assert.equal(saveWorkflow.review(draftFor(0), "approve").action, "approved");

  const editWorkflow = new ReviewWorkflow();
  assert.equal(editWorkflow.review(draftFor(1), "edit", "Edited reply").action, "edited");
  const rejectWorkflow = new ReviewWorkflow();
  assert.equal(rejectWorkflow.review(draftFor(2), "reject", "Rejected reply").action, "rejected");
  const escalationWorkflow = new ReviewWorkflow();
  assert.equal(escalationWorkflow.review(draftFor(3), "expert_assistance", undefined, "Needs specialist").action, "expert_assistance");
});

test("repeated saves remain safe, but duplicate approval and escalation are rejected", () => {
  const email = syntheticEmails()[4];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: "Use settings.", status: "answered", sources: [{ title: "Guide", url: "https://example.test/guide" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] });
  const saveWorkflow = new ReviewWorkflow();
  saveWorkflow.review(draft, "save", "First save");
  saveWorkflow.review(draft, "save", "Second save");
  assert.equal(saveWorkflow.history().length, 2);

  const approvalWorkflow = new ReviewWorkflow();
  approvalWorkflow.review(draft, "approve");
  assert.throws(() => approvalWorkflow.review(draft, "approve"), (error: ReviewAlreadyFinalizedError) => error.message === "Review is already finalized.");

  const escalationWorkflow = new ReviewWorkflow();
  escalationWorkflow.review(draft, "expert_assistance");
  assert.throws(() => escalationWorkflow.review(draft, "expert_assistance"), ReviewAlreadyFinalizedError);
});

test("review workflow rejects invalid runtime actions", () => {
  const email = syntheticEmails()[5];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: "Use settings.", status: "answered", sources: [{ title: "Guide", url: "https://example.test/guide" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] });
  assert.throws(() => (new ReviewWorkflow()).review(draft, "unknown" as never), /invalid review action/);
});

test("eligibility requires twenty unchanged low-risk cases and supports kill switch", () => {
  const tracker = new EligibilityTracker();
  for (let index = 0; index < 19; index += 1) tracker.record("how-to/general", { eventId: String(index), emailId: "e", action: "approved", generatedDraft: "same", finalContent: "same", promptVersion: "p", modelVersion: "m", createdAt: "now" }, "low", true);
  assert.equal(tracker.isEligible("how-to/general"), false);
  tracker.record("how-to/general", { eventId: "20", emailId: "e", action: "approved", generatedDraft: "same", finalContent: "same", promptVersion: "p", modelVersion: "m", createdAt: "now" }, "low", true);
  assert.equal(tracker.isEligible("how-to/general"), true);
  tracker.enableKillSwitch();
  assert.equal(tracker.isEligible("how-to/general"), false);
});

test("evaluation suite has twenty pending cases", () => assert.equal(defaultInboxEvaluationCases().length, 20));

test("Task 1 client preserves typed successful response", async () => {
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => new Response(JSON.stringify({ answer: "A", status: "answered", sources: [], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] }), { status: 200 }) });
  assert.equal((await client.query("Question", "r")).answer, "A");
});

test("Task 1 client rejects invalid responses", async () => {
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => new Response("{}", { status: 200 }) });
  await assert.rejects(() => client.query("Question", "r"), (error: Task1ClientError) => error.code === "invalid_response");
});

test("review UI renders escaped email content and controlled actions", () => {
  const email = syntheticEmails()[0];
  const draft = { emailId: email.id, classification: { category: "how-to" as const, subcategory: "general", urgency: "normal" as const, risk: "low" as const, productKnowledgeRequired: true, humanReviewRequired: true, promptVersion: "v1" }, requestSummary: "summary", suggestedReply: "reply <safe>", evidence: [], risk: "low" as const, humanApprovalRequired: true, nextAction: "human_review", promptVersion: "draft-v1" };
  const html = renderReviewPage({ ...email, body: "<script>bad</script>" }, draft);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("data-action=\"approve\""));
});

test("feedback stores correction aggregates and requires regression before prompt acceptance", () => {
  const store = new FeedbackStore();
  store.add({ eventId: "1", emailId: "e", action: "edited", generatedDraft: "secret", finalContent: "reply", reason: "missing context", promptVersion: "p1", modelVersion: "m1", createdAt: "now" });
  assert.equal(store.history()[0].generatedDraft, "secret");
  assert.deepEqual(store.correctionPatterns(), { "missing context": 1 });
  assert.throws(() => store.proposePrompt("p2", "new", false, "now"));
  assert.equal(store.proposePrompt("p2", "new", true, "now").accepted, true);
});

test("feedback and prompt revisions survive a store restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-feedback-"));
  const file = join(directory, "feedback.json");
  const first = new FeedbackStore(file);
  first.add({ eventId: "1", emailId: "e", action: "approved", generatedDraft: "reply", finalContent: "reply", promptVersion: "p1", modelVersion: "m1", createdAt: "now" });
  first.proposePrompt("p2", "approved prompt", true, "now");
  const restarted = new FeedbackStore(file);
  assert.equal(restarted.history().length, 1);
  assert.equal(restarted.revisionsHistory()[0].version, "p2");
  rmSync(directory, { recursive: true, force: true });
});

test("all seven email categories are represented", () => {
  assert.deepEqual(new Set(syntheticEmails().map((email) => email.expectedCategory)).size, 7);
});

test("held-out emails are distinct from tuning emails", () => {
  const emails = syntheticEmails();
  assert.equal(emails.filter((email) => !email.heldOut).length, 40);
  assert.equal(new Set(emails.filter((email) => email.heldOut).map((email) => email.id)).size, 10);
});

test("high-risk email classification fallback requires human review", async () => {
  const email = syntheticEmails().find((item) => item.expectedRisk === "high")!;
  const result = await classifyEmail(email, { classify: async () => { throw new Error("model down"); } });
  assert.equal(result.humanReviewRequired, true);
});

test("classification policy is passed to the model", async () => {
  let policy = "";
  await classifyEmail(syntheticEmails()[0], { classify: async (_prompt, receivedPolicy) => { policy = receivedPolicy; return { category: "how-to", subcategory: "setup", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }; } });
  assert.match(policy, /untrusted/i);
});

test("Task 1 client maps HTTP failures without fabricating content", async () => {
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => new Response(JSON.stringify({ error: "service_unavailable" }), { status: 503 }) });
  await assert.rejects(() => client.query("Question", "r"), (error: Task1ClientError) => error.code === "service_unavailable");
});

test("Task 1 client preserves image evidence", async () => {
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => new Response(JSON.stringify({ answer: "A", status: "answered", sources: [], image_references: ["image.png"], human_help_needed: false, request_id: "r", retrieval_trace: [] }), { status: 200 }) });
  assert.deepEqual((await client.query("Question", "r")).image_references, ["image.png"]);
});

test("eligibility resets after an edited final response", () => {
  const tracker = new EligibilityTracker();
  const event = { eventId: "1", emailId: "e", action: "edited" as const, generatedDraft: "a", finalContent: "b", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  assert.equal(tracker.record("how-to/general", event, "low", true), 0);
  assert.equal(tracker.isEligible("how-to/general"), false);
});

test("eligibility is separated by category", () => {
  const tracker = new EligibilityTracker();
  const event = { eventId: "1", emailId: "e", action: "approved" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  for (let index = 0; index < 20; index += 1) tracker.record("how-to/general", { ...event, eventId: String(index) }, "low", true);
  assert.equal(tracker.isEligible("how-to/general"), true);
  assert.equal(tracker.isEligible("troubleshooting/general"), false);
});

test("critical risk cannot qualify for autonomy", () => {
  const tracker = new EligibilityTracker();
  const event = { eventId: "1", emailId: "e", action: "approved" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  for (let index = 0; index < 20; index += 1) tracker.record("complaint", { ...event, eventId: String(index) }, "critical", true);
  assert.equal(tracker.isEligible("complaint"), false);
});

test("review requires replacement content for rejection", () => {
  const email = syntheticEmails()[0];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: "A", status: "answered", sources: [{ title: "Guide", url: "https://example.test" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] });
  assert.throws(() => new ReviewWorkflow().review(draft, "reject"));
});
