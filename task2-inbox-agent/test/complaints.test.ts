import assert from "node:assert/strict";
import test from "node:test";
import { AiConfigurationError, ClaudeComplaintAnalyzer, GeminiComplaintAnalyzer } from "../src/complaints.js";

test("complaint analyzer fails closed without server AI configuration", async () => {
  const analyzer = new ClaudeComplaintAnalyzer("replace-with-key", "replace-with-model");
  await assert.rejects(() => analyzer.analyze({ sender: "customer@example.com", subject: "Complaint", body: "The issue is unresolved." }), AiConfigurationError);
});

test("complaint analyzer parses strict provider JSON without exposing the key", async () => {
  const analyzer = new ClaudeComplaintAnalyzer("server-secret", "model", async () => new Response(JSON.stringify({
    content: [{ text: JSON.stringify({
      summary: "Customer reports an unresolved issue.",
      category: "service issue",
      keyIssues: ["Issue remains unresolved"],
      urgency: "high",
      sentiment: "negative",
      requestedResolution: "Investigation",
      relevantFacts: ["Customer reports repeated failure"],
      missingInformation: ["Exact error timestamp"],
      humanVerification: ["Confirm account history"],
      reply: "Thank you for raising this. We will review the details and follow up after verification.",
    }) }],
  }), { status: 200 }));
  const result = await analyzer.analyze({ sender: "customer@example.com", subject: "Complaint", body: "It still fails." });
  assert.equal(result.urgency, "high");
  assert.equal(result.reply.includes("verify"), false);
});

test("Gemini complaint analyzer parses structured JSON and keeps the key in the request URL only", async () => {
  let requestedUrl = "";
  const analyzer = new GeminiComplaintAnalyzer("server-secret", "gemini-test", async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: "A delayed service response caused frustration.",
        category: "support delay",
        keyIssues: ["Delayed response"],
        urgency: "medium",
        sentiment: "negative",
        requestedResolution: "An update",
        relevantFacts: ["Customer has been waiting"],
        missingInformation: ["Case reference"],
        humanVerification: ["Check support history"],
        reply: "Thank you for letting us know. We will review the case details before responding with confirmed information.",
      }) }] } }],
    }), { status: 200 });
  });
  const result = await analyzer.analyze({ sender: "customer@example.com", subject: "Complaint", body: "I have been waiting." });
  assert.equal(result.category, "support delay");
  assert.match(requestedUrl, /gemini-test:generateContent/);
});
