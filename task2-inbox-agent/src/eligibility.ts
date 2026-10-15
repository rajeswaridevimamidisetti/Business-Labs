import { FeedbackEvent, Risk } from "./schemas.js";

export interface EligibilityEvent { category: string; previous: number; current: number; reason: string; createdAt: string; }

export class EligibilityTracker {
  private readonly counts = new Map<string, number>();
  private readonly events: EligibilityEvent[] = [];
  private killSwitch = false;

  constructor(private readonly threshold = 20, private readonly now: () => string = () => new Date().toISOString()) {}

  record(category: string, event: FeedbackEvent, risk: Risk, qualityPassed: boolean): number {
    const previous = this.counts.get(category) ?? 0;
    const qualifying = event.action === "approved" && event.finalContent === event.generatedDraft && qualityPassed && risk === "low";
    const current = qualifying ? previous + 1 : 0;
    this.counts.set(category, current);
    this.events.push({ category, previous, current, reason: qualifying ? "qualifying_unchanged" : "reset_non_qualifying", createdAt: this.now() });
    return current;
  }

  isEligible(category: string): boolean { return !this.killSwitch && (this.counts.get(category) ?? 0) >= this.threshold; }
  enableKillSwitch(): void { this.killSwitch = true; }
  disableKillSwitch(): void { this.killSwitch = false; }
  audit(): readonly EligibilityEvent[] { return this.events; }
}
