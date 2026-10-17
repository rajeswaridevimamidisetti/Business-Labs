import { Classification, Draft, EvidenceStatus, IncomingEmail, Task1Answer } from "./schemas.js";

function requestLabel(email: IncomingEmail): string {
  return `"${email.subject}" (${email.expectedCategory})`;
}

function normalizedMessage(email: IncomingEmail): string {
  return `${email.subject} ${email.body}`.replace(/\s+/g, " ").trim();
}

function isVagueRequest(email: IncomingEmail): boolean {
  return /\b(next step|what information|help with my account|please explain|need help)\b/i.test(normalizedMessage(email))
    && !/\b(error|failed|failure|timeout|timed out|unable|cannot|can't|not working|broken|issue|problem)\b/i.test(normalizedMessage(email));
}

function unsupportedReply(email: IncomingEmail): string {
  const context = email.body.trim().replace(/\s+/g, " ").slice(0, 240);
  if (email.expectedCategory === "complaint") {
    return `Hello,\n\nI’m sorry this issue has affected your members. We want to investigate it carefully rather than guess at a resolution.\n\nPlease send the affected account area, when the incident started, the member impact you observed, and any exact error message or example member record that can be safely shared. We will escalate these details to a specialist for review.\n\nBest regards,\nSupport Team`;
  }
  if (isVagueRequest(email)) {
    return `Hello,\n\nThanks for reaching out. I can help clarify the next step.\n\nCould you tell us which account page or action you are trying to complete? If you see an error message, please include its exact text.\n\nWith those details, we can identify the appropriate next step or refer the issue to a specialist.\n\nBest regards,\nSupport Team`;
  }
  const requestedDetails = email.expectedCategory === "troubleshooting"
    ? "the exact error message and the account action or page where the problem occurs"
    : email.expectedCategory === "how-to"
      ? "the outcome you are trying to achieve and the page or account area where you are working"
      : "the specific outcome, relevant account or page context, and any error details";
  return `Hello,\n\nWe received your ${requestLabel(email)}: ${context}\n\nI could not find supporting Knowledge Brain evidence for this request, so I do not want to guess. Please provide ${requestedDetails}; a specialist can then review it accurately.\n\nBest regards,\nSupport Team`;
}

function supportedReply(email: IncomingEmail, answer: string): string {
  return `Hello,\n\nRegarding your ${requestLabel(email)}:\n\n${answer}\n\nPlease let us know if you need anything else.\n\nBest regards,\nSupport Team`;
}

export function createDraft(email: IncomingEmail, classification: Classification, knowledge: Task1Answer, now = new Date().toISOString()): Draft {
  const supported = knowledge.status === "answered" && Boolean(knowledge.answer) && knowledge.sources.length > 0;
  const evidenceStatus: EvidenceStatus = supported ? "supported" : knowledge.status === "retrieval_unavailable" || knowledge.status === "model_unavailable" ? "unavailable" : "insufficient";
  const humanApprovalRequired = classification.humanReviewRequired || classification.risk === "high" || classification.risk === "critical" || !supported || knowledge.human_help_needed;
  const suggestedReply = supported
    ? supportedReply(email, knowledge.answer!)
    : unsupportedReply(email);
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
    evidenceStatus,
    generatedAt: now,
    modelVersion: "task1-contract",
  };
}
