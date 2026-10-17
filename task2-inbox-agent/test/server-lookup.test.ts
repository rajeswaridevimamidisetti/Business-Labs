import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEmail } from "../src/email-lookup.js";

test("unknown draft email IDs do not resolve to the first fixture", () => {
  assert.equal(findEmail("does-not-exist"), undefined);
  assert.equal(findEmail(undefined), undefined);
});

test("known email IDs resolve only the requested fixture", () => {
  const email = findEmail("email-001");
  assert.equal(email?.id, "email-001");
  assert.notEqual(email?.id, "does-not-exist");
});

async function startServer(): Promise<{ child: ChildProcess; baseUrl: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "task2-server-"));
  const port = 8127 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, TASK2_PORT: String(port), TASK2_FEEDBACK_PATH: join(directory, "feedback.json") },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { child, baseUrl, directory };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  rmSync(directory, { recursive: true, force: true });
  throw new Error("Task 2 server did not become ready");
}

test("unknown IDs return 404 for draft and review endpoints", async () => {
  const running = await startServer();
  try {
    const draftResponse = await fetch(`${running.baseUrl}/v1/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailId: "does-not-exist" }),
    });
    assert.equal(draftResponse.status, 404);
    assert.deepEqual(await draftResponse.json(), { error: "email_not_found" });

    const reviewResponse = await fetch(`${running.baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailId: "does-not-exist", action: "approve" }),
    });
    assert.equal(reviewResponse.status, 404);
    assert.deepEqual(await reviewResponse.json(), { error: "email_not_found" });

    const reviewLookup = await fetch(`${running.baseUrl}/v1/reviews/does-not-exist`);
    assert.equal(reviewLookup.status, 404);
    assert.deepEqual(await reviewLookup.json(), { error: "email_not_found" });
  } finally {
    running.child.kill();
    rmSync(running.directory, { recursive: true, force: true });
  }
});
