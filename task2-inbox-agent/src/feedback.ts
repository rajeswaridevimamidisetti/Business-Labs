import { FeedbackEvent } from "./schemas.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PromptRevision { version: string; text: string; accepted: boolean; createdAt: string; }

export class FeedbackStore {
  private readonly events: FeedbackEvent[] = [];
  private readonly revisions: PromptRevision[] = [];

  constructor(private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return;
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as { events?: FeedbackEvent[]; revisions?: PromptRevision[] };
    this.events.push(...(stored.events ?? []));
    this.revisions.push(...(stored.revisions ?? []));
  }

  add(event: FeedbackEvent): void {
    this.events.push(event);
    this.persist();
  }

  history(): readonly FeedbackEvent[] { return this.events; }

  correctionPatterns(): Record<string, number> {
    return this.events.reduce<Record<string, number>>((patterns, event) => {
      if (event.reason) patterns[event.reason] = (patterns[event.reason] ?? 0) + 1;
      return patterns;
    }, {});
  }

  proposePrompt(version: string, text: string, regressionPassed: boolean, now: string): PromptRevision {
    if (!regressionPassed) throw new Error("regression dataset must pass before accepting prompt revision");
    const revision = { version, text, accepted: true, createdAt: now };
    this.revisions.push(revision);
    this.persist();
    return revision;
  }

  revisionsHistory(): readonly PromptRevision[] { return this.revisions; }

  private persist(): void {
    if (this.filePath) writeFileSync(this.filePath, JSON.stringify({ events: this.events, revisions: this.revisions }, null, 2));
  }
}
