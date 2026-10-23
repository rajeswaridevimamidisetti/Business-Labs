import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEmail } from "../src/email-lookup.js";
import { createTestSession } from "../src/auth.js";

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
    env: { ...process.env, TASK2_PORT: String(port), TASK2_FEEDBACK_PATH: join(directory, "feedback.json"), TASK2_DATABASE_URL: `sqlite://${join(directory, "task2.sqlite3")}`, TASK2_AUTH_SIGNING_SECRET: "test-only-auth-secret", GMAIL_LIVE_SEND_ENABLED: "false" },
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

async function stopServer(running: { child: ChildProcess; directory: string }): Promise<void> {
  running.child.kill();
  await new Promise<void>((resolve) => running.child.once("exit", () => resolve()));
  rmSync(running.directory, { recursive: true, force: true });
}

test("unknown IDs return 404 for draft and review endpoints", async () => {
  const running = await startServer();
  try {
    const authorization = `Bearer ${createTestSession({ subject: "test-owner", expiresAt: Date.now() + 60_000 }, "test-only-auth-secret")}`;
    const draftResponse = await fetch(`${running.baseUrl}/v1/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ emailId: "does-not-exist" }),
    });
    assert.equal(draftResponse.status, 404);
    assert.deepEqual(await draftResponse.json(), { error: "email_not_found" });

    const reviewResponse = await fetch(`${running.baseUrl}/v1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ emailId: "does-not-exist", action: "approve" }),
    });
    assert.equal(reviewResponse.status, 404);
    assert.deepEqual(await reviewResponse.json(), { error: "email_not_found" });

    const reviewLookup = await fetch(`${running.baseUrl}/v1/reviews/does-not-exist`, { headers: { authorization } });
    assert.equal(reviewLookup.status, 404);
    assert.deepEqual(await reviewLookup.json(), { error: "email_not_found" });
  } finally {
    await stopServer(running);
  }
});

test("protected endpoints reject unauthenticated requests", async () => {
  const running = await startServer();
  try {
    const response = await fetch(`${running.baseUrl}/v1/gmail/status`);
    assert.equal(response.status, 401);
  } finally {
    await stopServer(running);
  }
});

test("demo session issuance is removed and Gmail remains protected", async () => {
  const running = await startServer();
  try {
    const sessionResponse = await fetch(`${running.baseUrl}/v1/auth/demo-session`, { method: "POST", body: "{}" });
    assert.equal(sessionResponse.status, 401);
  } finally {
    await stopServer(running);
  }
});
