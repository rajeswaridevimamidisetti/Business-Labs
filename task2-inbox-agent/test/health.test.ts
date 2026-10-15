import assert from "node:assert/strict";
import test from "node:test";
import { health } from "../src/health.js";

test("foundation health", () => {
  assert.deepEqual(health(), { service: "task2-inbox-agent", status: "ok" });
});
