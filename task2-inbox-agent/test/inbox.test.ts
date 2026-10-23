import assert from "node:assert/strict";
import test from "node:test";
import { syntheticEmails } from "../src/dataset.js";
import { classifyEmail, classifyEmailDeterministically } from "../src/classifier.js";
import { createDraft } from "../src/drafts.js";
import { EligibilityTracker } from "../src/eligibility.js";
import { defaultInboxEvaluationCases } from "../src/evals.js";
import { ReviewAlreadyFinalizedError, ReviewWorkflow } from "../src/review.js";
import { queryHowToKnowledge, Task1Client, Task1ClientError } from "../src/task1-client.js";
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

test("different supported emails retain their selected subject in distinct drafts", () => {
  const answer = { answer: "Open Settings and choose Billing.", status: "answered", sources: [{ title: "Billing guide", url: "https://example.test/billing" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] };
  const classification = { category: "how-to" as const, subcategory: "general", urgency: "normal" as const, risk: "low" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const first = syntheticEmails()[0];
  const second = { ...first, id: "email-distinct", subject: "How do I update billing settings?", body: "I need to update billing settings for my account." };
  const firstDraft = createDraft(first, classification, answer);
  const secondDraft = createDraft(second, classification, answer);
  assert.notEqual(firstDraft.suggestedReply, secondDraft.suggestedReply);
  assert.match(secondDraft.suggestedReply, /How do I update billing settings/);
  assert.equal(secondDraft.evidence.length, 1);
});

test("unsupported troubleshooting drafts use the selected issue and request diagnostic details", () => {
  const email = { ...syntheticEmails()[12], subject: "Checkout returns a timeout", body: "Checkout times out after I click Pay.", expectedCategory: "troubleshooting" as const };
  const classification = { category: "troubleshooting" as const, subcategory: "synthetic", urgency: "normal" as const, risk: "medium" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const draft = createDraft(email, classification, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.match(draft.suggestedReply, /Checkout returns a timeout/);
  assert.match(draft.suggestedReply, /exact error message/);
  assert.match(draft.suggestedReply, /do not want to guess/);
  assert.equal(draft.evidence.length, 0);
  assert.equal(draft.nextAction, "expert_assistance");
});

test("complaint drafts acknowledge member impact and escalate without promising resolution", () => {
  const email = { ...syntheticEmails()[30], subject: "Member impact", body: "The issue has affected our members and we need help resolving it.", expectedCategory: "complaint" as const };
  const draft = createDraft(email, { category: "complaint", subcategory: "rule-based", urgency: "high", risk: "high", productKnowledgeRequired: true, humanReviewRequired: true, promptVersion: "v1" }, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.match(draft.suggestedReply, /affected your members/i);
  assert.match(draft.suggestedReply, /incident started|member impact/i);
  assert.match(draft.suggestedReply, /specialist/i);
  assert.doesNotMatch(draft.suggestedReply, /fixed|resolution timeline/i);
});

test("vague how-to requests ask for the goal and account area without inventing steps", () => {
  const email = { ...syntheticEmails()[0], subject: "How-to request", body: "Please explain the next step for our account and what information you need.", expectedCategory: "how-to" as const };
  const classification = { category: "how-to" as const, subcategory: "synthetic", urgency: "normal" as const, risk: "low" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const draft = createDraft(email, classification, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.match(draft.suggestedReply, /which account page or action/);
  assert.match(draft.suggestedReply, /exact text/);
  assert.equal(draft.evidence.length, 0);
});

test("vague troubleshooting requests do not ask for unrelated device details", () => {
  const email = { ...syntheticEmails()[12], subject: "Troubleshooting request", body: "Please explain the next step for our account and what information you need.", expectedCategory: "troubleshooting" as const };
  const classification = { category: "troubleshooting" as const, subcategory: "synthetic", urgency: "normal" as const, risk: "medium" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const draft = createDraft(email, classification, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.match(draft.suggestedReply, /which account page or action/);
  assert.doesNotMatch(draft.suggestedReply, /browser or device|reproduction steps|expected result/);
});

test("supported actionable questions use the returned evidence answer", () => {
  const email = { ...syntheticEmails()[0], subject: "How do I update billing settings?", body: "How do I update billing settings?", expectedCategory: "how-to" as const };
  const classification = { category: "how-to" as const, subcategory: "billing", urgency: "normal" as const, risk: "low" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const draft = createDraft(email, classification, { answer: "Open Settings, select Billing, and save your changes.", status: "answered", sources: [{ title: "Billing guide", url: "https://example.test/billing" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: ["chunk-1"] });
  assert.match(draft.suggestedReply, /Open Settings, select Billing/);
  assert.equal(draft.evidence.length, 1);
  assert.equal(draft.nextAction, "human_review");
});

test("unsupported questions remain honest and do not include an answer", () => {
  const email = { ...syntheticEmails()[0], subject: "Personal bank balance", body: "What is my current personal bank balance?", expectedCategory: "how-to" as const };
  const classification = { category: "how-to" as const, subcategory: "unsupported", urgency: "normal" as const, risk: "low" as const, productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" };
  const draft = createDraft(email, classification, { answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] });
  assert.match(draft.suggestedReply, /could not find supporting Knowledge Brain evidence/);
  assert.doesNotMatch(draft.suggestedReply, /your current balance is|bank balance is/);
  assert.equal(draft.evidence.length, 0);
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
  const sentEvent = (eventId: string) => ({ eventId, emailId: `e-${eventId}`, action: "sent" as const, generatedDraft: "same", finalContent: "same", promptVersion: "p", modelVersion: "m", createdAt: "now" });
  for (let index = 0; index < 19; index += 1) tracker.record("how-to/general", sentEvent(String(index)), "low", true);
  assert.equal(tracker.isEligible("how-to/general"), false);
  tracker.record("how-to/general", sentEvent("20"), "low", true);
  assert.equal(tracker.isEligible("how-to/general"), true);
  tracker.enableKillSwitch();
  assert.equal(tracker.isEligible("how-to/general"), false);
});

test("evaluation suite has twenty pending cases", () => assert.equal(defaultInboxEvaluationCases().length, 20));

test("Task 1 client preserves typed successful response", async () => {
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => new Response(JSON.stringify({ answer: "A", status: "answered", sources: [], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] }), { status: 200 }) });
  assert.equal((await client.query("Question", "r")).answer, "A");
});

test("Task 1 query includes the selected email subject, category, and message", async () => {
  let sentBody = "";
  const client = new Task1Client({
    baseUrl: "http://task1",
    fetcher: async (_url, options) => {
      sentBody = String(options?.body ?? "");
      return new Response(JSON.stringify({ answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] }), { status: 200 });
    },
  });

  await client.query("Subject: Checkout returns a timeout\nCategory: troubleshooting\nMessage: Checkout times out after I click Pay.", "r");
  assert.match(sentBody, /Checkout returns a timeout/);
  assert.match(sentBody, /troubleshooting/);
  assert.match(sentBody, /Checkout times out after I click Pay/);
});

test("How-To knowledge query retries once with a focused topic and preserves citations", async () => {
  let calls = 0;
  const sentBodies: string[] = [];
  const email = { ...syntheticEmails()[1] };
  const client = new Task1Client({
    baseUrl: "http://task1",
    fetcher: async (_url, options) => {
      calls += 1;
      const body = String(options?.body ?? "");
      sentBodies.push(body);
      if (calls === 1) {
        return new Response(JSON.stringify({ answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ answer: "Open Payment Settings.", status: "answered", sources: [{ title: "Payment Settings", url: "https://example.test/payment" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] }), { status: 200 });
    },
  });
  const result = await queryHowToKnowledge(client, email, "r");
  assert.equal(calls, 2);
  assert.match(sentBodies[0], /How can I update the billing settings/);
  assert.match(sentBodies[1], /Payment Settings billing/);
  assert.equal(result.sources[0].url, "https://example.test/payment");
});

test("signup-form How-To retry uses Form Manager evidence and accurate citation count", async () => {
  let calls = 0;
  const email = { ...syntheticEmails()[2] };
  const client = new Task1Client({
    baseUrl: "http://task1",
    fetcher: async (_url, options) => {
      calls += 1;
      const body = String(options?.body ?? "");
      if (calls === 1) return new Response(JSON.stringify({ answer: null, status: "insufficient_evidence", sources: [], image_references: [], human_help_needed: true, request_id: "r", retrieval_trace: [] }), { status: 200 });
      assert.equal(body, JSON.stringify({ question: "Form Manager member signup form" }));
      return new Response(JSON.stringify({ answer: "Use Form Manager.", status: "answered", sources: [{ title: "Form Manager", url: "https://example.test/form-manager" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] }), { status: 200 });
    },
  });
  const knowledge = await queryHowToKnowledge(client, email, "r");
  const draft = createDraft(email, classifyEmailDeterministically(email), knowledge);
  assert.equal(calls, 2);
  assert.equal(draft.evidenceStatus, "supported");
  assert.equal(draft.evidence.length, 1);
  assert.equal(draft.evidence[0].url, "https://example.test/form-manager");
  assert.match(draft.suggestedReply, /Use Form Manager/);
});

test("How-To unavailable service retries once and preserves the typed failure", async () => {
  let calls = 0;
  const email = { ...syntheticEmails()[1] };
  const client = new Task1Client({ baseUrl: "http://task1", fetcher: async () => {
    calls += 1;
    throw new Error("offline");
  } });
  await assert.rejects(() => queryHowToKnowledge(client, email, "r"), (error: Task1ClientError) => error.code === "unavailable");
  assert.equal(calls, 2);
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

test("review events retain evidence status and whether the reviewer changed text", () => {
  const email = syntheticEmails()[0];
  const draft = createDraft(email, { category: "how-to", subcategory: "general", urgency: "normal", risk: "low", productKnowledgeRequired: true, humanReviewRequired: false, promptVersion: "v1" }, { answer: "A", status: "answered", sources: [{ title: "Guide", url: "https://example.test" }], image_references: [], human_help_needed: false, request_id: "r", retrieval_trace: [] });
  const event = new ReviewWorkflow(() => "now").review(draft, "edit", "Changed reply", "clarity");
  assert.equal(event.evidenceStatus, "supported");
  assert.equal(event.evidence?.length, 1);
  assert.equal(event.finalTextChanged, true);
});

test("all seven email categories are represented", () => {
  const emails = syntheticEmails();
  assert.deepEqual(new Set(emails.map((email) => email.expectedCategory)).size, 7);
  assert.ok(emails.every((email) => email.importantFacts.length > 0 && email.expectedOutcome.length > 0));
  assert.ok(new Set(emails.map((email) => email.body)).size >= 20);
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

test("deterministic classification recognizes all dataset categories", () => {
  const classified = new Set(syntheticEmails().map((email) => classifyEmailDeterministically(email).category));
  assert.deepEqual(classified, new Set(["how-to", "troubleshooting", "project-request", "refund-cancellation", "complaint", "quote-request", "follow-up"]));
});

test("label policies persist independently and dry-run blocks unsafe automation", () => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-policy-"));
  const file = join(directory, "eligibility.json");
  const tracker = new EligibilityTracker(20, () => "now", file);
  tracker.setPolicy("how-to", "General Settings", 2, true);
  const decision = tracker.decide("how-to", { humanApprovalRequired: true, evidenceStatus: "supported", risk: "low" }, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.dryRun, true);
  const restarted = new EligibilityTracker(20, () => "now", file);
  assert.equal(restarted.policy("how-to")?.parentSettingType, "General Settings");
  assert.equal(restarted.decisionsHistory().length, 1);
  rmSync(directory, { recursive: true, force: true });
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

test("eligibility persists and resets after a failed or changed send", () => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-eligibility-"));
  const file = join(directory, "eligibility.json");
  const tracker = new EligibilityTracker(2, () => "now", file);
  const event = { eventId: "sent-1", emailId: "e", action: "sent" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  tracker.record("how-to/general", event, "low", true);
  const restarted = new EligibilityTracker(2, () => "now", file);
  assert.equal(restarted.record("how-to/general", { ...event, eventId: "failed-1", finalContent: "changed" }, "low", false), 0);
  assert.equal(restarted.isEligible("how-to/general"), false);
  rmSync(directory, { recursive: true, force: true });
});

test("eligibility is separated by category", () => {
  const tracker = new EligibilityTracker();
  const event = { eventId: "1", emailId: "e", action: "sent" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  for (let index = 0; index < 20; index += 1) tracker.record("how-to/general", { ...event, eventId: String(index) }, "low", true);
  assert.equal(tracker.isEligible("how-to/general"), true);
  assert.equal(tracker.isEligible("troubleshooting/general"), false);
});

test("approval alone does not qualify and duplicate sent events do not increment twice", () => {
  const tracker = new EligibilityTracker(2);
  const approved = { eventId: "approved", emailId: "e", action: "approved" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  assert.equal(tracker.record("how-to/general", approved, "low", true), 0);
  const sent = { eventId: "sent", emailId: "e", action: "sent" as const, generatedDraft: "a", finalContent: "a", promptVersion: "p", modelVersion: "m", createdAt: "now" };
  assert.equal(tracker.record("how-to/general", sent, "low", true), 1);
  assert.equal(tracker.record("how-to/general", sent, "low", true), 1);
  assert.equal(tracker.isEligible("how-to/general"), false);
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
