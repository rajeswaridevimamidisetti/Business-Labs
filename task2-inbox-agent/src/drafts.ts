import { Classification, Draft, IncomingEmail, Task1Answer } from "./schemas.js";

export function createDraft(email: IncomingEmail, classification: Classification, knowledge: Task1Answer): Draft {
  const supported = knowledge.status === "answered" && Boolean(knowledge.answer) && knowledge.sources.length > 0;
  const humanApprovalRequired = classification.humanReviewRequired || classification.risk === "high" || classification.risk === "critical" || !supported || knowledge.human_help_needed;
  const suggestedReply = supported
    ? `Hello,\n\nRegarding your request: ${knowledge.answer}\n\nPlease let us know if you need anything else.`
    : "Hello,\n\nThanks for reaching out. We need a little more information or a specialist review before we can answer accurately. We will follow up with you.\n\nBest regards,";
  return {
    emailId: email.id,
    classification,
    requestSummary: email.body.slice(0, 240),
    suggestedReply,
    evidence: supported ? knowledge.sources : [],
    risk: classification.risk,
    humanApprovalRequired,
    nextAction: supported ? "human_review" : "expert_assistance",
    promptVersion: "draft-v1",
  };
}
