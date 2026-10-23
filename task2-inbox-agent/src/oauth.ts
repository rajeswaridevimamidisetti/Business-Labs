import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1000;
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export function loadOAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
  expectedRedirectUri = `http://127.0.0.1:${environment.TASK2_PORT ?? "8002"}/v1/gmail/oauth/callback`,
): Pick<OAuthConfig, "clientId" | "clientSecret" | "redirectUri" | "authUri" | "tokenUri"> {
  const jsonPath = environment.GOOGLE_OAUTH_CLIENT_JSON_PATH?.trim();
  type WebClient = { client_id?: string; client_secret?: string; redirect_uris?: string[]; auth_uri?: string; token_uri?: string };
  let file: WebClient | undefined;
  if (jsonPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      throw new OAuthConfigurationError("Google OAuth client JSON could not be read or parsed");
    }
    if (!parsed || typeof parsed !== "object" || !("web" in parsed)) {
      throw new OAuthConfigurationError("Google OAuth client JSON must contain a Web application configuration");
    }
    const web = (parsed as { web?: unknown }).web;
    if (!web || typeof web !== "object" || Array.isArray(web)) {
      throw new OAuthConfigurationError("Google OAuth client JSON contains an invalid Web application configuration");
    }
    file = web as WebClient;
    if (!file.client_id || !file.client_secret) {
      throw new OAuthConfigurationError("Google OAuth client JSON is missing client_id or client_secret");
    }
    if (!Array.isArray(file.redirect_uris) || !file.redirect_uris.includes(expectedRedirectUri)) {
      throw new OAuthConfigurationError("Google OAuth client JSON does not authorize the Task 2 callback URI");
    }
  }
  const clientId = file?.client_id ?? environment.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = file?.client_secret ?? environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = file?.redirect_uris?.find((uri) => uri === expectedRedirectUri)
    ?? environment.GOOGLE_OAUTH_REDIRECT_URI?.trim()
    ?? expectedRedirectUri;
  if (redirectUri !== expectedRedirectUri) {
    throw new OAuthConfigurationError("Google OAuth redirect URI must exactly match the Task 2 callback URI");
  }
  if (!clientId || !clientSecret) {
    throw new OAuthConfigurationError("Google OAuth client ID and client secret are required");
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    authUri: file?.auth_uri ?? GOOGLE_AUTH,
    tokenUri: file?.token_uri ?? GOOGLE_TOKEN,
  };
}

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  authUri?: string;
  tokenUri?: string;
  encryptionKey?: string;
  tokenPath?: string;
  fetcher?: typeof fetch;
  requestedScopes?: readonly string[];
}

export interface StoredToken {
  ownerId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  emailAddress: string;
  scopes?: string[];
}

export class OAuthConfigurationError extends Error {}

export class GmailOAuth {
  private readonly fetcher: typeof fetch;
  private readonly states = new Map<string, { ownerId: string; createdAt: number }>();
  private readonly tokens = new Map<string, StoredToken>();

  constructor(private readonly config: OAuthConfig = {}) {
    this.fetcher = config.fetcher ?? fetch;
    if (config.tokenPath && existsSync(config.tokenPath)) {
      const encrypted = readFileSync(config.tokenPath, "utf8");
      for (const token of JSON.parse(this.decrypt(encrypted)) as StoredToken[]) this.tokens.set(token.ownerId, token);
    }
  }

  configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  start(ownerId: string): string {
    this.requireConfigured();
    if (!ownerId.trim()) throw new Error("owner identity is required");
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, { ownerId, createdAt: Date.now() });
    const url = new URL(this.config.authUri ?? GOOGLE_AUTH);
    url.searchParams.set("client_id", this.config.clientId!);
    url.searchParams.set("redirect_uri", this.config.redirectUri!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (this.config.requestedScopes ?? [GMAIL_READ_SCOPE]).join(" "));
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async callback(code: string, state: string): Promise<StoredToken> {
    this.requireConfigured();
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) throw new Error("OAuth state is invalid or expired");
    const response = await this.fetcher(this.config.tokenUri ?? GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        redirect_uri: this.config.redirectUri!,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error("Google OAuth token exchange failed");
    const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!payload.access_token) throw new Error("Google OAuth response did not include an access token");
    const scopes = payload.scope?.split(/\s+/).filter(Boolean) ?? [];
    const requiredScopes = this.config.requestedScopes ?? [GMAIL_READ_SCOPE];
    const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new Error(`Gmail authorization is missing required scopes; reconnect and approve Gmail access (${missingScopes.join(", ")})`);
    }
    const previous = this.tokens.get(pending.ownerId);
    const token: StoredToken = {
      ownerId: pending.ownerId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? previous?.refreshToken,
      expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
      emailAddress: "",
      scopes,
    };
    this.tokens.set(token.ownerId, token);
    this.persist();
    return token;
  }

  get(ownerId: string): StoredToken | undefined {
    return this.tokens.get(ownerId);
  }

  missingScopes(ownerId: string): string[] {
    const token = this.tokens.get(ownerId);
    const requiredScopes = this.config.requestedScopes ?? [GMAIL_READ_SCOPE];
    if (!token) return [...requiredScopes];
    return requiredScopes.filter((scope) => !token.scopes?.includes(scope));
  }

  async credentials(ownerId: string, requiredScope?: string): Promise<{ accessToken: string; userId: string } | undefined> {
    const token = this.tokens.get(ownerId);
    if (!token) return undefined;
    if (requiredScope && !token.scopes?.includes(requiredScope)) throw new Error("Gmail authorization is missing the required send scope; reconnect and approve Gmail send access");
    if (!token.expiresAt || token.expiresAt > Date.now() + 30_000) return { accessToken: token.accessToken, userId: "me" };
    if (!token.refreshToken) throw new Error("Gmail access expired; reconnect the account");
    this.requireConfigured();
    const response = await this.fetcher(this.config.tokenUri ?? GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        refresh_token: token.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error("Gmail access expired or revoked; reconnect the account");
    const payload = await response.json() as { access_token?: string; expires_in?: number; scope?: string };
    if (!payload.access_token) throw new Error("Google did not return a refreshed access token");
    token.accessToken = payload.access_token;
    token.expiresAt = payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined;
    if (payload.scope) token.scopes = payload.scope.split(/\s+/).filter(Boolean);
    this.persist();
    return { accessToken: token.accessToken, userId: "me" };
  }

  setEmail(ownerId: string, emailAddress: string): StoredToken {
    const token = this.tokens.get(ownerId);
    if (!token) throw new Error("Gmail token is not stored");
    token.emailAddress = emailAddress;
    this.persist();
    return token;
  }

  disconnect(ownerId: string): void {
    this.tokens.delete(ownerId);
    this.persist();
  }

  private requireConfigured(): void {
    if (!this.configured()) throw new OAuthConfigurationError("Google OAuth is not configured");
    if (!this.config.encryptionKey) throw new OAuthConfigurationError("OAuth token encryption key is not configured");
  }

  private persist(): void {
    if (!this.config.tokenPath) return;
    mkdirSync(dirname(this.config.tokenPath), { recursive: true });
    writeFileSync(this.config.tokenPath, this.encrypt(JSON.stringify([...this.tokens.values()])), { mode: 0o600 });
  }

  private key(): Buffer {
    const key = Buffer.from(this.config.encryptionKey ?? "", "base64");
    if (key.length !== 32) throw new OAuthConfigurationError("OAuth encryption key must be a base64-encoded 32-byte key");
    return key;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  }

  private decrypt(value: string): string {
    const payload = JSON.parse(value) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
  }
}
