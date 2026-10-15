import { Draft, FeedbackEvent, ReviewStatus } from "./schemas.js";

export class ReviewWorkflow {
  private readonly events: FeedbackEvent[] = [];
  private readonly statuses = new Map<string, ReviewStatus>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  review(draft: Draft, action: "approve" | "edit" | "reject" | "expert_assistance", finalContent?: string, reason?: string): FeedbackEvent {
    const status: ReviewStatus = action === "approve" ? "approved" : action === "edit" ? "edited" : action === "reject" ? "rejected" : "expert_assistance";
    if ((action === "edit" || action === "reject") && !finalContent?.trim()) throw new Error("replacement content is required");
    if (this.statuses.has(draft.emailId)) throw new Error("review is already finalized");
    const event: FeedbackEvent = { eventId: `review-${this.events.length + 1}`, emailId: draft.emailId, action: status, generatedDraft: draft.suggestedReply, finalContent: finalContent ?? draft.suggestedReply, reason, promptVersion: draft.promptVersion, modelVersion: "claude-config-pending", createdAt: this.now() };
    this.events.push(event);
    this.statuses.set(draft.emailId, status);
    return event;
  }

  history(): readonly FeedbackEvent[] { return this.events; }
}
