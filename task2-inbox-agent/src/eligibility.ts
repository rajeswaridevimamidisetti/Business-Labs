import { FeedbackEvent, Risk } from "./schemas.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EligibilityEvent { category: string; previous: number; current: number; reason: string; createdAt: string; }

export class EligibilityTracker {
  private readonly counts = new Map<string, number>();
  private readonly events: EligibilityEvent[] = [];
  private killSwitch = false;
  private readonly seenEvents = new Set<string>();

  constructor(private readonly threshold = 20, private readonly now: () => string = () => new Date().toISOString(), private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return;
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as { counts?: Record<string, number>; events?: EligibilityEvent[]; killSwitch?: boolean; seenEvents?: string[] };
    for (const [category, count] of Object.entries(stored.counts ?? {})) this.counts.set(category, count);
    this.events.push(...(stored.events ?? []));
    this.killSwitch = stored.killSwitch ?? false;
    for (const eventId of stored.seenEvents ?? []) this.seenEvents.add(eventId);
  }

  record(category: string, event: FeedbackEvent, risk: Risk, qualityPassed: boolean): number {
    if (this.seenEvents.has(event.eventId)) return this.counts.get(category) ?? 0;
    this.seenEvents.add(event.eventId);
    const previous = this.counts.get(category) ?? 0;
    const qualifying = event.action === "sent" && event.finalContent === event.generatedDraft && qualityPassed && risk === "low";
    const current = qualifying ? previous + 1 : 0;
    this.counts.set(category, current);
    this.events.push({ category, previous, current, reason: qualifying ? "qualifying_unchanged" : "reset_non_qualifying", createdAt: this.now() });
    this.persist();
    return current;
  }

  isEligible(category: string): boolean { return !this.killSwitch && (this.counts.get(category) ?? 0) >= this.threshold; }
  enableKillSwitch(): void { this.killSwitch = true; this.persist(); }
  disableKillSwitch(): void { this.killSwitch = false; this.persist(); }
  audit(): readonly EligibilityEvent[] { return this.events; }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ counts: Object.fromEntries(this.counts), events: this.events, killSwitch: this.killSwitch, seenEvents: [...this.seenEvents] }, null, 2));
  }
}
