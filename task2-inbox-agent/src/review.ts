import { Draft, FeedbackEvent, ReviewAction, ReviewStatus } from "./schemas.js";

export class ReviewAlreadyFinalizedError extends Error {
  constructor(public readonly emailId: string, public readonly status: ReviewStatus) {
    super("Review is already finalized.");
    this.name = "ReviewAlreadyFinalizedError";
  }
}

export class ReviewWorkflow {
  private readonly events: FeedbackEvent[] = [];
  private readonly statuses = new Map<string, ReviewStatus>();

  constructor(private readonly now: () => string = () => new Date().toISOString(), initialEvents: readonly FeedbackEvent[] = []) {
    this.events.push(...initialEvents);
    for (const event of initialEvents) {
      if (event.action !== "pending") this.statuses.set(event.emailId, event.action);
    }
  }

  review(draft: Draft, action: ReviewAction, finalContent?: string, reason?: string): FeedbackEvent {
    if (!["approve", "save", "edit", "reject", "expert_assistance"].includes(action)) {
      throw new Error("invalid review action");
    }
    const status: ReviewStatus = action === "approve" ? "approved" : action === "edit" ? "edited" : action === "reject" ? "rejected" : action === "expert_assistance" ? "expert_assistance" : "pending";
    if ((action === "edit" || action === "reject") && !finalContent?.trim()) throw new Error("replacement content is required");
    const existingStatus = this.statuses.get(draft.emailId);
    if (existingStatus) throw new ReviewAlreadyFinalizedError(draft.emailId, existingStatus);
    const finalText = finalContent ?? draft.suggestedReply;
    const event: FeedbackEvent = {
      eventId: `review-${this.events.length + 1}`,
      emailId: draft.emailId,
      action: status,
      generatedDraft: draft.suggestedReply,
      finalContent: finalText,
      reason,
      promptVersion: draft.promptVersion,
      modelVersion: draft.modelVersion ?? "task1-contract",
      createdAt: this.now(),
      evidence: draft.evidence,
      evidenceStatus: draft.evidenceStatus,
      finalTextChanged: finalText !== draft.suggestedReply,
      outcome: status,
    };
    this.events.push(event);
    if (action !== "save") this.statuses.set(draft.emailId, status);
    return event;
  }

  history(): readonly FeedbackEvent[] { return this.events; }

  status(emailId: string): ReviewStatus {
    return this.statuses.get(emailId) ?? "pending";
  }
}
