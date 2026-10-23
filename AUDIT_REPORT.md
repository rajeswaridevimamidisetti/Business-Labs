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

## Gmail authorization follow-up

The persistent sync error was caused by the sync route requiring
`gmail.send` even though synchronization only lists and reads Gmail messages.
The Gmail OAuth start flow requested only `gmail.readonly`, so the stored token
correctly lacked the send permission and sync failed before importing messages.

The sync path now validates only `gmail.readonly`. The `gmail.send` scope is
requested and validated only when `GMAIL_LIVE_SEND_ENABLED=true`, and the live
send route enforces that scope if explicitly enabled. Existing encrypted tokens
are not deleted or overwritten automatically. Under-scoped tokens are reported
as requiring reconnection for the current configuration.

Additional verification:

- Task 2 tests: 77 passed, 0 failed.
- Task 2 typecheck: passed.
- Frontend typecheck: passed.
- Frontend production build: passed with elevated filesystem access; the
  previous esbuild `Access is denied` result was sandbox-related.
- `GMAIL_LIVE_SEND_ENABLED=false` was verified without exposing environment
  values.
- No real Gmail account, OAuth callback, inbox sync, or email send was tested
  in this environment.

To reconnect Gmail, restart Task 2, sign into the application, click
**Reconnect Gmail**, and approve the read permission. If live sending is later
enabled intentionally, approve the additional send permission and verify the
Google Cloud OAuth consent configuration first.

## Data export

Added the authenticated `GET /v1/data/export` endpoint. It downloads a ZIP
containing all files under the Task 1, Task 2, and Task 3 data directories,
including databases and JSON data, while excluding environment files, OAuth
tokens, encrypted Gmail credentials, caches, dependencies, and build output.
The archive format was locally validated and Task 2 tests/typecheck pass.
Because Task 1 and Task 3 currently contain global stores without complete
authenticated-owner metadata, this endpoint is a complete local workspace
backup rather than a per-user filtered export.

## Knowledge Brain sitemap importer follow-up

The Task 1 crawler was updated to support the Brilliant Directories article
import path without silently truncating production runs. `TASK1_MAX_ARTICLES=0`
now means unlimited eligible URLs, and `TASK1_ARTICLE_PATH_FRAGMENT` defaults to
`/support/solutions/articles/`. The refresh manager persists article discovery
membership and exposes `/sitemaps/{id}/stats` for backend-derived dashboard
counts. The frontend source-management panel displays those persisted counts.

HTTP 404 responses remain non-actionable while the URL is still present in the
successfully discovered sitemap. A URL absent from that source is tracked as a
consecutive missing check and is subject to the configured threshold/action. HTTP
301 responses are quarantined immediately. These behaviors are covered by the
new Task 1 crawler tests.

Verification performed:

- Task 1 unittest suite: 53 passed, 0 failed.
- Task 1 OpenAPI JSON validation: passed.
- Frontend typecheck: passed.
- Frontend production build: passed.

The live Brilliant Directories sitemap was not imported automatically; doing so
would issue a large external crawl. Run the local Task 1 server and use the
authenticated operational workflow to start a deliberate discovery/import run.
Task 1 remains loopback-only and currently requires an authenticated gateway
before its management API is exposed beyond local development.

## Step 1 local sitemap extraction

Added [sitemap_import.py](task1-knowledge-brain/src/knowledge_brain/sitemap_import.py)
and the `knowledge_brain.sitemap_extract` CLI for parsing a supplied local XML
file only. It persists `sitemap_imports`, `sitemap_source_urls`, and
`sitemap_rejected_urls` transactionally in the existing Task 1 SQLite database,
and writes a JSON verification report when an input file is supplied.

No 1,699-URL sitemap payload was found in the repository or supplied attachment
available to this session. Therefore no production extraction was run, no live
sitemap was fetched, and no 1,699/1,540 counts are claimed. Existing database
counts were checked read-only after the change: `sources` 50, `article_versions`
100, `sitemap_configs` 4, and `sitemap_refresh_runs` 16; they were preserved.

Step 1 tests: 56 passed, 0 failed, including normalization, article
classification, duplicate removal, rejected URL reporting, transactional
persistence, and repeat extraction behavior. The remaining manual action is to
place the supplied sitemap XML in the repository and run the documented CLI.

The Step 1 review UI reads `POST /sitemap-data/stats` and
`POST /sitemap-data/urls` through the existing Task 1 loopback proxy. It supports
all-URL versus article-only views, text search, and 50-row pagination. The
production URL files are intentionally not created until the real supplied XML
is available; a temporary fixture run verified that the CLI writes both files
and its JSON report.

## Latest Google sign-in failure diagnosis

The observed failure was not evidence of a missing authenticated session or a safe
reason to bypass Google. Task 2 logs captured Google returning `access_denied` for a
login attempt, which means the provider flow was cancelled or denied. The frontend
previously displayed a generic message for this provider result. Separate controlled
local tests also showed that the backend could reach Google's token endpoint and that
an intentionally synthetic/reused authorization code was rejected with `invalid_grant`.

The OIDC client now maps provider discovery, signing-key, and token-exchange network
failures to safe actionable errors, applies a timeout, and clears a failed discovery
cache so a later login can retry. The frontend distinguishes provider denial and
backend-to-Google connectivity/token-exchange failures. State, nonce, PKCE, issuer,
audience, signature, expiry, and session-cookie checks remain enforced.

Verification:

- Task 2 tests: 77 passed, 0 failed.
- Task 2 typecheck: passed.
- Frontend typecheck: passed.
- Frontend production build: passed after the sign-in UI change (`tsc -b && vite
  build`).
- Task 2 health: `http://127.0.0.1:8002/health` returned 200.
- Signed-out session: `/v1/auth/session` returned `authenticated:false` with the
  provider configured.
- Login route: returned a Google authorization redirect containing state, PKCE, and
  `http://127.0.0.1:8002/v1/auth/callback`.
- Real Google consent and callback were not completed, so real external sign-in is
  not claimed as verified.

## Live sitemap import verification

Implemented [sitemap_fetch.py](task1-knowledge-brain/src/knowledge_brain/sitemap_fetch.py)
for a deliberate live Step 1 import. It fetches the configured HTTPS source and
same-host child sitemap documents only, validates child URLs before requesting
them, and stops after sitemap parsing/persistence; it does not fetch article pages.

The live command was executed against
`https://support.brilliantdirectories.com/support/sitemap.xml` on
2026-10-24. It fetched one valid XML document and completed successfully:

- Total sitemap URL entries: 1,699.
- Unique sitemap URLs saved: 1,699.
- Unique article URLs identified and saved: 1,540.
- Duplicate URLs removed: 0.
- Rejected URLs: 0.
- Sitemap documents fetched: 1.
- Database rows: 1,699 in `sitemap_source_urls`, including 1,540 article rows;
  no duplicate source rows.
- Generated files: `task1-knowledge-brain/data/sitemap-urls.txt` (1,699
  unique lines) and `task1-knowledge-brain/data/article-urls.txt` (1,540
  unique lines).
- Latest metadata/report: `task1-knowledge-brain/data/sitemap-extraction-report.json`.

The existing `sources` and `article_versions` counts remained 50 and 100 during
the verification. The live importer writes only the Step 1 tables and generated
URL files; it does not delete or replace existing Knowledge Brain records.

Verification after import:

- Task 1 suite: 59 tests passed, 0 failed, including the new nested-index,
  safe-child-validation, and live-collection persistence tests.
- Task 1 OpenAPI JSON parsed successfully and the existing API tests passed.
- The running Task 1 API returned the same 1,699/1,540 counts from
  `POST /sitemap-data/stats`; paginated all-URL and article-only calls each
  returned 50 rows with totals 1,699 and 1,540 respectively.
- No full article-content extraction was started and no email operation was
  performed.

## AI IT Consultant UI and complete sitemap management

The local application now has a single authenticated AI IT Consultant shell
with Overview, Knowledge Brain, Sitemap Management, Inbox Agent, Meeting to
Scope, and System Status navigation. The redesigned sitemap workspace uses the
persisted Task 1 inventory rather than frontend fixtures. It provides summary
cards, configured-source management, discovery-only refresh, refresh history,
search, All/Article/Other filtering, 25/50/100/250-row pagination, URL metadata,
copy actions, TXT exports for all URLs and articles, and CSV export.

Backend changes are in `task1-knowledge-brain/src/knowledge_brain/management.py`
and `task1-knowledge-brain/src/knowledge_brain/api.py`. The new read/export
routes are `POST /sitemap-data/stats`, `POST /sitemap-data/urls`, and
`POST /sitemap-data/export`; the discovery-only refresh route is
`POST /sitemap-data/refresh`. Refresh validates HTTPS same-host sitemap/index
documents, enforces timeout/size/document limits, persists the existing
transactional import tables, records refresh history, and never downloads
article pages. The frontend implementation is in `frontend/src/App.tsx` and
`frontend/src/styles.css`.

The actual persisted verification after the live refresh was:

- Total sitemap URLs: 1,699.
- Unique sitemap URLs saved: 1,699.
- Unique article URLs: 1,540.
- Sitemaps/documents processed: 1.
- Duplicate URLs: 0.
- Rejected URLs: 0.
- `task1-knowledge-brain/data/sitemap-urls.txt`: 1,699 unique lines.
- `task1-knowledge-brain/data/article-urls.txt`: 1,540 unique lines.
- API article filter total: 1,540; API all-URL total: 1,699; article export: 1,540 lines.

The new live refresh endpoint was exercised successfully against
`https://support.brilliantdirectories.com/support/sitemap.xml` and returned
HTTP 200 with the same counts. An earlier non-escalated attempt returned a
truthful HTTP 502 because outbound HTTPS was unavailable in that sandbox; the
retry with network access succeeded. No article content was fetched and no
email was sent. The actual source was added as a new local sitemap
configuration; the four pre-existing sitemap configurations and Knowledge
Brain source/article records were not deleted or overwritten.

Verification commands and results:

- Task 1: `task1-knowledge-brain\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v` — **63 passed, 0 failed**.
- Task 2: `npm run typecheck` — **passed**; `npm test` — **77 passed, 0 failed**.
- Task 3: `$env:PYTHONPATH='src'; ..\\task1-knowledge-brain\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v` — **21 passed, 0 failed**. The package has no local Python executable of its own, so the repository Task 1 virtual environment was used for its dependency-free test suite.
- Frontend: `npm run typecheck` — **passed**; `npm run build` — **passed** (`vite 5.4.21`, production bundle generated in `frontend/dist`). The first build attempt was blocked only by the sandbox's esbuild filesystem restriction and passed after the required local escalation.
- Task 1 OpenAPI JSON parse — **passed**.
- Runtime health: `http://127.0.0.1:8001/health`, `http://127.0.0.1:8002/health`, `http://127.0.0.1:8003/health`, and `http://127.0.0.1:5173/` — **HTTP 200** at verification time.
- Signed-out browser check: `http://127.0.0.1:5173/` showed the real `Sign in with Google` gate. The authenticated sitemap UI was not entered because no browser session was supplied; no authentication bypass was used. Real Google consent remains an external user action and is not claimed as verified here.

The Task 1 API remains loopback-only. The frontend development proxy expects
Task 1 on `http://127.0.0.1:8001`, Task 2 on `http://127.0.0.1:8002`, Task 3 on
`http://127.0.0.1:8003`, and the frontend on
`http://127.0.0.1:5173`. Live Gmail sending remains disabled by configuration.
