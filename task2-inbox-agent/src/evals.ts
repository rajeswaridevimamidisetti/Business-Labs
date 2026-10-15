export interface InboxEvaluationCase { id: string; category: string; expected: string; heldOut: boolean; status: "pending"; }
export interface InboxEvaluationResult { id: string; configuration: string; status: "pending" | "complete" | "failed"; accuracy?: number; factualSupport?: number; latencyMs?: number; cost?: number; unsafeActionRate?: number; error?: string; }

export function defaultInboxEvaluationCases(): InboxEvaluationCase[] {
  return Array.from({ length: 20 }, (_, index) => ({ id: `task2-${String(index + 1).padStart(2, "0")}`, category: ["how-to", "troubleshooting", "complaint", "refund-cancellation"][index % 4], expected: index % 4 === 3 ? "human_review" : "grounded_draft", heldOut: true, status: "pending" }));
}
