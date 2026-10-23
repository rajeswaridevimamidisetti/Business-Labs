import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export class OidcConfigurationError extends Error {}
export class OidcAuthenticationError extends Error {}

type OidcConfig = { clientId: string; clientSecret: string; redirectUri: string; issuer: string; frontendUrl: string };
type PendingLogin = { state: string; nonce: string; verifier: string; expiresAt: number };
type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };

const pending = new Map<string, PendingLogin>();
let discoveryPromise: Promise<Discovery> | undefined;
let jwksCache: { expiresAt: number; keys: Array<Record<string, unknown>> } | undefined;

export function loadOidcConfig(env: NodeJS.ProcessEnv, port: number): OidcConfig | undefined {
  let file: { client_id?: string; client_secret?: string } | undefined;
  const jsonPath = env.GOOGLE_OAUTH_CLIENT_JSON_PATH?.trim();
  if (jsonPath && existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { web?: { client_id?: string; client_secret?: string }; installed?: { client_id?: string; client_secret?: string } };
      file = parsed.web ?? parsed.installed;
    } catch { return undefined; }
  }
  const clientId = (env.GOOGLE_OIDC_CLIENT_ID?.trim() || file?.client_id || env.GOOGLE_OAUTH_CLIENT_ID?.trim());
  const clientSecret = (env.GOOGLE_OIDC_CLIENT_SECRET?.trim() || file?.client_secret || env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
  if (!clientId || !clientSecret || clientId.startsWith("replace-with-") || clientSecret.startsWith("replace-with-")) return undefined;
  const issuer = (env.GOOGLE_OIDC_ISSUER?.trim() || "https://accounts.google.com").replace(/\/$/, "");
  if (issuer !== "https://accounts.google.com") return undefined;
  return {
    clientId,
    clientSecret,
    redirectUri: env.GOOGLE_OIDC_REDIRECT_URI?.trim() || `http://127.0.0.1:${port}/v1/auth/callback`,
    issuer,
    frontendUrl: (env.FRONTEND_URL?.trim() || "http://127.0.0.1:5173").replace(/\/$/, ""),
  };
}

function base64url(value: Buffer | string): string { return Buffer.from(value).toString("base64url"); }
function codeChallenge(verifier: string): string { return base64url(createHash("sha256").update(verifier).digest()); }

export function createLogin(config: OidcConfig): { url: string; state: string } {
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(32));
  pending.set(state, { state, nonce, verifier, expiresAt: Date.now() + 10 * 60_000 });
  const url = new URL(`${config.issuer}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: "openid email profile", state, nonce, code_challenge: codeChallenge(verifier), code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
  return { url: url.toString(), state };
}

async function discovery(config: OidcConfig): Promise<Discovery> {
  discoveryPromise ??= fetch(`${config.issuer}/.well-known/openid-configuration`).then(async (response) => {
    if (!response.ok) throw new OidcAuthenticationError("identity provider discovery failed");
    return await response.json() as Discovery;
  });
  return discoveryPromise;
}

async function jwks(uri: string): Promise<Array<Record<string, unknown>>> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(uri);
  if (!response.ok) throw new OidcAuthenticationError("identity provider signing keys unavailable");
  const body = await response.json() as { keys?: Array<Record<string, unknown>> };
  if (!body.keys?.length) throw new OidcAuthenticationError("identity provider returned no signing keys");
  jwksCache = { keys: body.keys, expiresAt: Date.now() + 60 * 60_000 };
  return body.keys;
}

function decodePart(value: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw new OidcAuthenticationError("identity provider returned an invalid token"); }
}

async function validateIdToken(token: string, config: OidcConfig, expectedNonce: string, metadata: Discovery): Promise<{ subject: string; expiresAt: number }> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new OidcAuthenticationError("identity provider returned an invalid ID token");
  const header = decodePart(encodedHeader);
  const claims = decodePart(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OidcAuthenticationError("unsupported identity provider token algorithm");
  const key = (await jwks(metadata.jwks_uri)).find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!key) throw new OidcAuthenticationError("identity provider signing key not found");
  const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n as string, e: key.e as string }, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, "base64url"))) throw new OidcAuthenticationError("identity provider token signature is invalid");
  const audience = claims.aud;
  const validAudience = audience === config.clientId || (Array.isArray(audience) && audience.includes(config.clientId));
  if (metadata.issuer !== "https://accounts.google.com" || claims.iss !== "https://accounts.google.com") throw new OidcAuthenticationError("identity provider issuer is invalid");
  if (!validAudience || claims.nonce !== expectedNonce || typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new OidcAuthenticationError("identity provider token claims are invalid");
  return { subject: claims.sub, expiresAt: claims.exp * 1000 };
}

export async function completeLogin(config: OidcConfig, code: string, state: string): Promise<{ subject: string; expiresAt: number }> {
  const login = pending.get(state);
  pending.delete(state);
  if (!login || login.expiresAt <= Date.now()) throw new OidcAuthenticationError("login state is missing or expired");
  const metadata = await discovery(config);
  const response = await fetch(metadata.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: login.verifier }).toString() });
  if (!response.ok) {
    let providerCode = "unknown";
    try { providerCode = String((await response.json() as { error?: unknown }).error ?? providerCode).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80); } catch { /* preserve the safe generic code */ }
    throw new OidcAuthenticationError(`identity provider token exchange failed ${providerCode}`);
  }
  const tokens = await response.json() as { id_token?: string };
  if (!tokens.id_token) throw new OidcAuthenticationError("identity provider did not return an ID token");
  return validateIdToken(tokens.id_token, config, login.nonce, metadata);
}

export function oidcConfigured(config: OidcConfig | undefined): boolean { return Boolean(config); }
