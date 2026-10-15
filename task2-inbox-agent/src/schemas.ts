export type Category =
  | "how-to"
  | "troubleshooting"
  | "project-request"
  | "refund-cancellation"
  | "complaint"
  | "quote-request"
  | "follow-up";

export type Risk = "low" | "medium" | "high" | "critical";
export type ReviewStatus = "pending" | "approved" | "edited" | "rejected" | "expert_assistance";

export interface IncomingEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
  expectedCategory: Category;
  expectedRisk: Risk;
  expectedHandling: string;
  requiresTask1Evidence: boolean;
  heldOut: boolean;
}

export interface Classification {
  category: Category;
  subcategory: string;
  urgency: "low" | "normal" | "high" | "urgent";
  risk: Risk;
  productKnowledgeRequired: boolean;
  humanReviewRequired: boolean;
  promptVersion: string;
}

export interface Citation {
  title: string;
  url: string;
  section?: string | null;
  chunk_id?: string | null;
}

export interface Task1Answer {
  answer: string | null;
  status: string;
  sources: Citation[];
  image_references: string[];
  human_help_needed: boolean;
  request_id: string;
  retrieval_trace: string[];
}

export interface Draft {
  emailId: string;
  classification: Classification;
  requestSummary: string;
  suggestedReply: string;
  evidence: Citation[];
  risk: Risk;
  humanApprovalRequired: boolean;
  nextAction: string;
  promptVersion: string;
}

export interface FeedbackEvent {
  eventId: string;
  emailId: string;
  action: ReviewStatus;
  generatedDraft: string;
  finalContent?: string;
  reason?: string;
  promptVersion: string;
  modelVersion: string;
  createdAt: string;
}

export function validateClassification(value: unknown): Classification {
  if (!value || typeof value !== "object") throw new Error("invalid classification");
  const candidate = value as Record<string, unknown>;
  const categories: Category[] = ["how-to", "troubleshooting", "project-request", "refund-cancellation", "complaint", "quote-request", "follow-up"];
  const risks: Risk[] = ["low", "medium", "high", "critical"];
  if (!categories.includes(candidate.category as Category) || typeof candidate.subcategory !== "string" || !risks.includes(candidate.risk as Risk)) throw new Error("invalid classification fields");
  if (!['low', 'normal', 'high', 'urgent'].includes(String(candidate.urgency))) throw new Error("invalid urgency");
  if (typeof candidate.productKnowledgeRequired !== "boolean" || typeof candidate.humanReviewRequired !== "boolean" || typeof candidate.promptVersion !== "string") throw new Error("invalid classification shape");
  return candidate as unknown as Classification;
}
