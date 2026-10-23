import { FeedbackEvent, Risk } from "./schemas.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EligibilityEvent { category: string; previous: number; current: number; reason: string; createdAt: string; }
export interface LabelPolicy { parentSettingType: string; threshold: number; enabled: boolean; updatedAt: string; }
export interface AutoSendDecision { category: string; allowed: boolean; dryRun: boolean; reason: string; createdAt: string; }

export class EligibilityTracker {
  private readonly counts = new Map<string, number>();
  private readonly events: EligibilityEvent[] = [];
  private readonly policies = new Map<string, LabelPolicy>();
  private readonly decisions: AutoSendDecision[] = [];
  private killSwitch = false;
  private readonly seenEvents = new Set<string>();

  constructor(private readonly threshold = 20, private readonly now: () => string = () => new Date().toISOString(), private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return;
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as { counts?: Record<string, number>; events?: EligibilityEvent[]; policies?: Record<string, LabelPolicy>; decisions?: AutoSendDecision[]; killSwitch?: boolean; seenEvents?: string[] };
    for (const [category, count] of Object.entries(stored.counts ?? {})) this.counts.set(category, count);
    this.events.push(...(stored.events ?? []));
    for (const [category, policy] of Object.entries(stored.policies ?? {})) this.policies.set(category, policy);
    this.decisions.push(...(stored.decisions ?? []));
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

  setPolicy(category: string, parentSettingType: string, threshold: number, enabled: boolean, now = this.now()): void {
    if (!category.trim() || !parentSettingType.trim()) throw new Error("category and parent setting type are required");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 30) throw new Error("threshold must be an integer from 1 to 30");
    this.policies.set(category, { parentSettingType, threshold, enabled, updatedAt: now });
    this.persist();
  }

  policy(category: string): LabelPolicy | undefined { return this.policies.get(category); }
  isEligible(category: string): boolean {
    const policy = this.policies.get(category);
    return !this.killSwitch && (policy?.enabled ?? true) && (this.counts.get(category) ?? 0) >= (policy?.threshold ?? this.threshold);
  }
  decide(category: string, draft: { humanApprovalRequired: boolean; evidenceStatus?: string; risk: Risk }, alreadySent: boolean, dryRun = true): AutoSendDecision {
    let reason = "eligible";
    let allowed = this.isEligible(category);
    if (this.killSwitch) { allowed = false; reason = "kill_switch_enabled"; }
    else if (alreadySent) { allowed = false; reason = "message_already_sent"; }
    else if (draft.humanApprovalRequired) { allowed = false; reason = "human_review_required"; }
    else if (draft.evidenceStatus !== "supported") { allowed = false; reason = "supporting_evidence_required"; }
    else if (draft.risk !== "low") { allowed = false; reason = "high_risk_message"; }
    const decision = { category, allowed, dryRun, reason, createdAt: this.now() };
    this.decisions.push(decision);
    this.persist();
    return decision;
  }
  decisionsHistory(): readonly AutoSendDecision[] { return this.decisions; }
  enableKillSwitch(): void { this.killSwitch = true; this.persist(); }
  disableKillSwitch(): void { this.killSwitch = false; this.persist(); }
  audit(): readonly EligibilityEvent[] { return this.events; }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ counts: Object.fromEntries(this.counts), events: this.events, policies: Object.fromEntries(this.policies), decisions: this.decisions, killSwitch: this.killSwitch, seenEvents: [...this.seenEvents] }, null, 2));
  }
}
