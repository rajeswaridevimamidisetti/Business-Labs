# Business-Labs Authentication Audit

## Root cause

The frontend rendered a permanent `AuthenticationRequired` screen whenever `sessionStorage` did not contain `business-labs-session`. No login route or session acquisition flow existed. The Task 2 backend only accepted a pre-issued HMAC bearer token through `TASK2_AUTH_SIGNING_SECRET`, while `.env.example` contained only a placeholder gateway secret and no identity-provider configuration. Therefore no browser session could ever be acquired locally. Protected Gmail, draft, review, and sync routes correctly returned 401, but the UI had no way to obtain a valid session.

The current Google Web client configuration was also inspected without exposing credentials. Its downloaded JSON contained the Gmail redirect URI, but did not contain `http://127.0.0.1:8002/v1/auth/callback` and did not contain `http://127.0.0.1:5173` as a JavaScript origin. The generated OIDC request has the correct callback, PKCE, state, and nonce. Google therefore cannot complete sign-in until those Cloud Console values are added.

## Implemented changes

- Added Google OpenID Connect authorization-code login with PKCE, state, and nonce handling in `task2-inbox-agent/src/oidc.ts`.
- Added server-side ID-token validation for Google issuer, client audience, RS256 signature through Google JWKS, nonce, subject, and expiry.
- Added `/v1/auth/session`, `/v1/auth/login`, `/v1/auth/callback`, and `/v1/auth/logout`.
- Issued only an HttpOnly, SameSite session cookie after successful provider validation. The browser never supplies an account ID or bearer token.
- Kept bearer-token support for service clients and migrated browser API calls to `credentials: "include"`.
- Added frontend loading, Google sign-in, provider-not-configured, login-failure, logout, and session-expiration states.
- Preserved authenticated-subject ownership for Gmail, drafts, reviews, sync, and AI operations.
- Fixed the local smoke runner to sign its own test request and fixed its Task 2 fixture route. `GMAIL_LIVE_SEND_ENABLED` remains false.
- Added Google OIDC variables and callback setup to `task2-inbox-agent/.env.example` and `README.md`.
- Preserved the existing `task2-inbox-agent/.env`; it was not overwritten. Added only missing local settings, generated a new session-signing secret, and kept the Gemini key backend-only. `.env` is ignored by Git.
- Updated OIDC loading to use the existing server-side Google Web client JSON when explicit OIDC credentials are absent.
- Added safe callback diagnostics: provider denial, expired state, discovery, token-exchange, and ID-token validation failures are logged as non-secret codes and returned to the frontend without exposing tokens or credentials.

## Verification performed

- Task 2 typecheck: passed.
- Task 2 test suite: 76 passed, 0 failed.
- Authentication tests cover valid, missing, invalid, and expired cookie sessions.
- Task 3 regression suite: 21 passed, 0 failed.
- Task 1 regression suite: 50 passed, 0 failed.
- Frontend typecheck: passed.
- Frontend production build: passed.
- Local E2E HTTP smoke: passed.
- Runtime checks with the configured server: `/v1/auth/session` returned 200 with `authenticated:false` and `providerConfigured:true`, `/v1/gmail/status` returned 401 without a session, all three health endpoints returned 200, and Vite served on port 5173.
- The login route is configured to redirect to Google's authorization host; no Google consent or callback was completed in this environment.
- The configured client JSON was checked: Gmail redirect URI present; OIDC redirect URI absent; frontend JavaScript origin absent. Direct access to Google was unavailable from this sandbox because outbound access to `accounts.google.com:443` is blocked.
- No Gmail send or real email was performed. Live sending remains disabled.

## External setup still required

1. In Google Cloud Console, open **APIs & Services → Credentials**, select the Web application client loaded by `GOOGLE_OAUTH_CLIENT_JSON_PATH`, and add `http://127.0.0.1:8002/v1/auth/callback` and `http://127.0.0.1:8002/v1/gmail/oauth/callback` as authorized redirect URIs. Add `http://127.0.0.1:5173` under authorized JavaScript origins; it is not a redirect URI. The Gmail URI is already present locally; the OIDC URI and JavaScript origin are currently missing.
3. Enable the Gmail API and configure the OAuth consent screen. The Gmail flow requests `https://www.googleapis.com/auth/gmail.readonly`; send scope is not requested while live sending is disabled.
4. Open the frontend, select **Sign in with Google**, complete Google consent, then use **Connect Gmail** and complete the separate Gmail consent. After the verified callbacks, the existing Gmail flow becomes available.

The configured Gemini model was preserved as `gemini-3.5-flash-lite`; its live availability was not tested against the external API. If Google reports that it is unavailable, select a model from the official model list: https://ai.google.dev/gemini-api/docs/models, then update only the backend `GEMINI_MODEL` value.

Successful external sign-in and Gmail connection were not claimed as verified because this environment has no Google client credentials or authenticated browser account. No secrets were created, exposed, committed, or deployed.

## Local URLs

- Frontend: http://127.0.0.1:5173/
- Task 1 health: http://127.0.0.1:8001/health
- Task 2 health: http://127.0.0.1:8002/health
- Task 3 health: http://127.0.0.1:8003/health
