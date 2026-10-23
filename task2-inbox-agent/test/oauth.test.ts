import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GmailOAuth, loadOAuthConfig, OAuthConfigurationError } from "../src/oauth.js";

const key = Buffer.alloc(32, 7).toString("base64");

function configured(path: string, fetcher?: typeof fetch, requestedScopes?: readonly string[]): GmailOAuth {
  return new GmailOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:8002/v1/gmail/oauth/callback",
    encryptionKey: key,
    tokenPath: path,
    fetcher,
    requestedScopes,
  });
}

test("OAuth start requests the minimum inbox read scope with incremental authorization", () => {
  const manager = configured(join(mkdtempSync(join(tmpdir(), "oauth-")), "tokens.enc"));
  const url = new URL(manager.start("owner-a"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.ok((url.searchParams.get("state") ?? "").length >= 32);
  assert.match(url.searchParams.get("scope") ?? "", /gmail\.readonly/);
  assert.doesNotMatch(url.searchParams.get("scope") ?? "", /gmail\.send/);
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
});

test("OAuth start requests send scope only for a send-enabled configuration", () => {
  const manager = configured(join(mkdtempSync(join(tmpdir(), "oauth-send-")), "tokens.enc"), undefined, [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  const url = new URL(manager.start("owner-send"));
  assert.match(url.searchParams.get("scope") ?? "", /gmail\.readonly/);
  assert.match(url.searchParams.get("scope") ?? "", /gmail\.send/);
});

test("OAuth callback rejects a state that was not issued", async () => {
  const manager = configured(join(mkdtempSync(join(tmpdir(), "oauth-")), "tokens.enc"));
  await assert.rejects(() => manager.callback("code", "invalid"), /state is invalid or expired/);
});

test("OAuth tokens are encrypted at rest and can be loaded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-"));
  const path = join(directory, "tokens.enc");
  const manager = configured(path, async () => new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" }), { status: 200 }));
  const state = new URL(manager.start("owner-a")).searchParams.get("state")!;
  await manager.callback("authorization-code", state);
  const encrypted = readFileSync(path, "utf8");
  assert.equal(encrypted.includes("access-secret"), false);
  const restored = configured(path);
  assert.equal(restored.get("owner-a")?.accessToken, "access-secret");
  assert.equal(restored.get("owner-a")?.refreshToken, "refresh-secret");
  rmSync(directory, { recursive: true, force: true });
});

test("OAuth send credentials fail closed when Gmail send scope is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-scope-"));
  const manager = configured(join(directory, "tokens.enc"), async () => new Response(JSON.stringify({
    access_token: "read-only-token",
    refresh_token: "refresh-secret",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  }), { status: 200 }));
  const state = new URL(manager.start("owner-scope")).searchParams.get("state")!;
  await manager.callback("authorization-code", state);
  await assert.rejects(
    () => manager.credentials("owner-scope", "https://www.googleapis.com/auth/gmail.send"),
    /missing the required send scope/,
  );
  rmSync(directory, { recursive: true, force: true });
});

test("OAuth requires encryption configuration", () => {
  const manager = new GmailOAuth({ clientId: "id", clientSecret: "secret", redirectUri: "http://localhost/callback" });
  assert.throws(() => manager.start("owner-a"), OAuthConfigurationError);
});

function writeClient(directory: string, value: unknown): string {
  const path = join(directory, "google-oauth-client.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

const webClient = {
  web: {
    client_id: "json-client",
    client_secret: "json-secret",
    redirect_uris: ["http://127.0.0.1:8002/v1/gmail/oauth/callback"],
    auth_uri: "https://accounts.example.test/auth",
    token_uri: "https://accounts.example.test/token",
  },
};

test("OAuth loader accepts a Web client JSON file", () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-config-"));
  const config = loadOAuthConfig({ GOOGLE_OAUTH_CLIENT_JSON_PATH: writeClient(directory, webClient) });
  assert.deepEqual(config, { clientId: "json-client", clientSecret: "json-secret", redirectUri: "http://127.0.0.1:8002/v1/gmail/oauth/callback", authUri: "https://accounts.example.test/auth", tokenUri: "https://accounts.example.test/token" });
  rmSync(directory, { recursive: true, force: true });
});

test("OAuth loader rejects missing, malformed, incomplete, unsupported, and mismatched files", () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-config-"));
  assert.throws(() => loadOAuthConfig({ GOOGLE_OAUTH_CLIENT_JSON_PATH: join(directory, "missing.json") }), /could not be read or parsed/);
  const malformed = join(directory, "malformed.json");
  writeFileSync(malformed, "{");
  assert.throws(() => loadOAuthConfig({ GOOGLE_OAUTH_CLIENT_JSON_PATH: malformed }), /could not be read or parsed/);
  for (const value of [
    { web: { client_id: "id", redirect_uris: ["http://127.0.0.1:8002/v1/gmail/oauth/callback"] } },
    { installed: { client_id: "id", client_secret: "secret" } },
    { web: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost/callback"] } },
  ]) {
    assert.throws(() => loadOAuthConfig({ GOOGLE_OAUTH_CLIENT_JSON_PATH: writeClient(directory, value) }), OAuthConfigurationError);
  }
  rmSync(directory, { recursive: true, force: true });
});

test("OAuth loader uses environment fallback and file credentials take precedence", () => {
  const fallback = loadOAuthConfig({
    GOOGLE_OAUTH_CLIENT_ID: "env-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "env-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "http://127.0.0.1:8002/v1/gmail/oauth/callback",
  });
  assert.equal(fallback.clientId, "env-client");
  const directory = mkdtempSync(join(tmpdir(), "oauth-config-"));
  const config = loadOAuthConfig({
    GOOGLE_OAUTH_CLIENT_JSON_PATH: writeClient(directory, webClient),
    GOOGLE_OAUTH_CLIENT_ID: "wrong-env-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "wrong-env-secret",
  });
  assert.equal(config.clientId, "json-client");
  assert.equal(config.clientSecret, "json-secret");
  rmSync(directory, { recursive: true, force: true });
});
