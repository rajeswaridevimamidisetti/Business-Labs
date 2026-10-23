import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GmailSyncStore } from "../src/sync-store.js";

test("sync store persists owner-scoped messages and deduplicates stable Gmail IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "gmail-sync-"));
  const path = join(directory, "sync.json");
  const store = new GmailSyncStore(path);
  const message = { ownerId: "owner-a", gmailMessageId: "m1", subject: "hello", labelIds: ["INBOX"], syncedAt: new Date().toISOString() };
  assert.equal(store.upsert(message), true);
  assert.equal(store.upsert({ ...message, subject: "updated" }), false);
  assert.equal(store.messages("owner-a").length, 1);
  assert.equal(store.messages("owner-b").length, 0);
  const restored = new GmailSyncStore(path);
  assert.equal(restored.messages("owner-a")[0]?.subject, "updated");
  assert.match(readFileSync(path, "utf8"), /m1/);
  rmSync(directory, { recursive: true, force: true });
});

test("sync store prevents overlapping runs for the same owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gmail-sync-"));
  const store = new GmailSyncStore(join(directory, "sync.json"));
  let release: (() => void) | undefined;
  const first = store.runExclusive("owner-a", () => new Promise<number>((resolve) => { release = () => resolve(1); }));
  await assert.rejects(() => store.runExclusive("owner-a", async () => 2), /already running/);
  release?.();
  assert.equal(await first, 1);
  rmSync(directory, { recursive: true, force: true });
});
