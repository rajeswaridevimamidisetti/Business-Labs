import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, AuthenticationError, createTestSession } from "../src/auth.js";

const secret = "test-only-auth-secret";

test("missing authentication is rejected", () => {
  assert.throws(() => authenticate({ headers: {} }, secret), AuthenticationError);
});

test("expired and tampered sessions are rejected", () => {
  const expired = createTestSession({ subject: "owner-a", expiresAt: Date.now() - 1 }, secret);
  assert.throws(() => authenticate({ headers: { authorization: `Bearer ${expired}` } }, secret), /expired/);
  const valid = createTestSession({ subject: "owner-a", expiresAt: Date.now() + 60_000 }, secret);
  assert.throws(() => authenticate({ headers: { authorization: `Bearer ${valid}x` } }, secret), /invalid/);
});

test("authenticated subject is the only owner identity returned", () => {
  const token = createTestSession({ subject: "owner-a", expiresAt: Date.now() + 60_000 }, secret);
  const principal = authenticate({ headers: { authorization: `Bearer ${token}` } }, secret);
  assert.equal(principal.subject, "owner-a");
  assert.ok(principal.expiresAt > Date.now());
});
