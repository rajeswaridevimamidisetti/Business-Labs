import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SyncedMessage {
  ownerId: string;
  gmailMessageId: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  internalDate?: string;
  labelIds: string[];
  syncedAt: string;
}

export interface SyncState {
  ownerId: string;
  status: "idle" | "running" | "success" | "error";
  startedAt?: string;
  completedAt?: string;
  lastSuccessfulAt?: string;
  nextPageToken?: string;
  importedCount: number;
  error?: string;
}

interface StoreData {
  messages: SyncedMessage[];
  states: SyncState[];
}

export class GmailSyncStore {
  private data: StoreData = { messages: [], states: [] };
  private readonly locks = new Set<string>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>;
      this.data = { messages: Array.isArray(parsed.messages) ? parsed.messages : [], states: Array.isArray(parsed.states) ? parsed.states : [] };
    }
  }

  state(ownerId: string): SyncState {
    return this.data.states.find((state) => state.ownerId === ownerId) ?? { ownerId, status: "idle", importedCount: 0 };
  }

  messages(ownerId: string, limit = 50, offset = 0): SyncedMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) throw new Error("limit must be 1-500 and offset must be non-negative");
    return this.data.messages.filter((message) => message.ownerId === ownerId).slice(offset, offset + limit);
  }

  async runExclusive(ownerId: string, task: () => Promise<number>): Promise<number> {
    if (this.locks.has(ownerId)) throw new Error("Gmail synchronization is already running");
    this.locks.add(ownerId);
    const startedAt = new Date().toISOString();
    this.setState({ ...this.state(ownerId), status: "running", startedAt, error: undefined });
    try {
      const importedCount = await task();
      const completedAt = new Date().toISOString();
      this.setState({ ...this.state(ownerId), status: "success", completedAt, lastSuccessfulAt: completedAt, importedCount, error: undefined });
      return importedCount;
    } catch (error: unknown) {
      this.setState({ ...this.state(ownerId), status: "error", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "gmail_sync_failed" });
      throw error;
    } finally {
      this.locks.delete(ownerId);
    }
  }

  upsert(message: SyncedMessage): boolean {
    const index = this.data.messages.findIndex((item) => item.ownerId === message.ownerId && item.gmailMessageId === message.gmailMessageId);
    if (index >= 0) {
      this.data.messages[index] = message;
      this.persist();
      return false;
    }
    this.data.messages.push(message);
    this.persist();
    return true;
  }

  setPageToken(ownerId: string, nextPageToken?: string): void {
    this.setState({ ...this.state(ownerId), nextPageToken });
  }

  private setState(state: SyncState): void {
    const index = this.data.states.findIndex((item) => item.ownerId === state.ownerId);
    if (index >= 0) this.data.states[index] = state;
    else this.data.states.push(state);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
