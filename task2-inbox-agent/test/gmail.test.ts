import test from "node:test";
import assert from "node:assert/strict";
import { GmailClient } from "../src/gmail.js";

test("Gmail client is unavailable without OAuth configuration", async () => {
  const client = new GmailClient();
  assert.equal(client.configured(), false);
  await assert.rejects(() => client.listMessages(), /OAuth is not configured/);
});

test("Gmail sending defaults to explicit dry-run and does not call the network", async () => {
  let calls = 0;
  const client = new GmailClient({ fetcher: async () => { calls += 1; return new Response("{}"); } });
  const result = await client.sendMessage({ to: "customer@example.test", subject: "Re: question", body: "Reply" });
  assert.deepEqual(result, { mode: "dry-run", messageId: null, accepted: true, reason: "explicit dry-run", preview: { to: "customer@example.test", subject: "Re: question", body: "Reply" } });
  assert.equal(calls, 0);
});

test("disabled live sending returns a preview and never calls Gmail send", async () => {
  let sendCalls = 0;
  const client = new GmailClient({
    accessToken: "test-token",
    userId: "me",
    liveSendEnabled: false,
    fetcher: async (input) => {
      if (String(input).endsWith("/messages/send")) sendCalls += 1;
      return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
    },
  });
  const result = await client.sendMessage({ to: "recipient@example.test", subject: "Preview", body: "No delivery" }, false);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.reason, "live sending is disabled");
  assert.deepEqual(result.preview, { to: "recipient@example.test", subject: "Preview", body: "No delivery" });
  assert.equal(sendCalls, 0);
});

test("Gmail message listing supports pagination and detail retrieval", async () => {
  const calls: string[] = [];
  const client = new GmailClient({
    accessToken: "test-token",
    userId: "me",
    fetcher: async (input) => {
      calls.push(String(input));
      if (String(input).includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next" }), { status: 200 });
      return new Response(JSON.stringify({ id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "hello", payload: { headers: [{ name: "Subject", value: "Subject" }] } }), { status: 200 });
    },
  });

  const page = await client.listMessagesPage("", 100);
  assert.equal(page.nextPageToken, "next");
  assert.equal(page.messages[0]?.id, "m1");
  const detail = await client.getMessage("m1");
  assert.equal(detail.subject, "Subject");
  assert.equal(calls.length, 2);
});

test("live Gmail send requires explicit opt-in and uses the configured account", async () => {
  let requestUrl = "";
  const client = new GmailClient({
    accessToken: "token",
    userId: "me",
    liveSendEnabled: true,
    fetcher: async (input) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ id: "gmail-1" }), { status: 200 });
    },
  });
  const result = await client.sendMessage({ to: "customer@example.test", subject: "Subject", body: "Body" }, false);
  assert.equal(result.messageId, "gmail-1");
  assert.match(requestUrl, /users\/me\/messages\/send$/);
});

test("Gmail retries transient rate-limit responses", async () => {
  let attempts = 0;
  const client = new GmailClient({
    accessToken: "test-token",
    userId: "me",
    fetcher: async () => {
      attempts += 1;
      return attempts < 2 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ messages: [] }), { status: 200 });
    },
  });
  await client.listMessages();
  assert.equal(attempts, 2);
});
