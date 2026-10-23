import { createHmac, timingSafeEqual } from "node:crypto";

export interface AuthPrincipal {
  subject: string;
  expiresAt: number;
}

export class AuthenticationError extends Error {}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function createTestSession(principal: AuthPrincipal, secret: string): string {
  const payload = base64url(JSON.stringify(principal));
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function authenticate(request: { headers: Record<string, string | string[] | undefined> }, secret = process.env.TASK2_AUTH_SIGNING_SECRET): AuthPrincipal {
  if (!secret?.trim()) throw new AuthenticationError("authenticated session provider is not configured");
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new AuthenticationError("authentication required");
  const token = header.slice("Bearer ".length).trim();
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new AuthenticationError("invalid authenticated session");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new AuthenticationError("invalid authenticated session");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new AuthenticationError("invalid authenticated session"); }
  if (!parsed || typeof parsed !== "object") throw new AuthenticationError("invalid authenticated session");
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.subject !== "string" || !candidate.subject.trim() || typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= Date.now()) {
    throw new AuthenticationError("authenticated session is expired or invalid");
  }
  return { subject: candidate.subject, expiresAt: candidate.expiresAt };
}
