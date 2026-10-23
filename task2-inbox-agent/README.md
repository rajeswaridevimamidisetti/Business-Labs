# Task 2 Inbox Agent

## Current workflow

The local service reads messages only after an authenticated user completes
Google OAuth. Gmail message metadata is synchronized into an owner-scoped
local store, and the browser console uses `/v1/gmail/messages/local`,
`/v1/drafts`, and `/v1/reviews` through the Vite proxy. An empty mailbox is
reported honestly; no synthetic inbox is provided.

## Evidence-grounded drafts

Task 1 is queried with the selected email subject, category, and message.
Only a response with `status: "answered"`, a non-empty answer, and at least
one source is treated as supported. Drafts expose `evidenceStatus` as
`supported`, `insufficient`, or `unavailable`, and the UI displays the
backend's actual source count.

How-To requests send the original question and subject context first. If that
request is insufficient or unavailable, Task 2 makes at most one bounded
three-second retry using a concise topic query (for example, Payment Settings
or Form Manager). The retry does not create evidence; it can only use sources
returned by Task 1.

Unsupported or unavailable requests receive a category-aware clarification or
escalation draft. They never receive fabricated product instructions,
policies, prices, account information, or evidence.

## Review, audit, and delivery status

Approve, Save edit, Reject, and Escalate remain review actions. They are
recorded through `/v1/reviews` and persisted to
`data/local/task2-feedback.json` (override with `TASK2_FEEDBACK_PATH`).
Approval is not email delivery; no email provider or real send integration is
configured.

Draft delivery state is persisted separately in SQLite at
`TASK2_DATABASE_URL` (default `sqlite://data/local/task2.sqlite3`). The
database contains immutable draft versions, normalized approval integrity
hashes, Gmail account binding, audit events, and idempotent send-attempt
records. Draft edits create a new version and clear approval. Send claims use
an immediate transaction and a unique `(owner, email, version)` claim, so
duplicate requests cannot claim the same approved version concurrently.
Attempts left in `sending` during a process restart are recovered as
`outcome_unknown` and must be reconciled rather than retried automatically. A
provider message ID is retained when Gmail returns one. Reconciliation fetches
that exact Gmail message and marks an attempt `sent` only when the provider
recipient and subject match the approved draft. If no ID exists or metadata
does not match, the attempt remains `outcome_unknown`; Gmail does not provide a
general idempotency key for `messages.send`, so manual evidence is required.
The
schema migration is additive and runs on startup; back up the SQLite file
before deployment or migration rollback. A rollback must restore the backup
and the application version together—never drop these tables on a live
database.

The 20-case eligibility tracker is a separate, durable state machine in
`src/eligibility.ts`. It counts only explicit `sent` events with unchanged
content, low risk, and a passing quality check. Approval alone cannot qualify
a category. Autonomy is disabled unless an authorized delivery integration
explicitly emits a sent event.

## Gmail OAuth, synchronization boundary, and safe test mode

The Gmail connection uses Google's OAuth 2.0 authorization-code flow. Configure
the following environment variables (never commit the real values):

```powershell
$env:GOOGLE_OAUTH_CLIENT_JSON_PATH = "C:\Users\<YOUR_WINDOWS_USERNAME>\AppData\Local\Business-Labs\google-oauth-client.json"
$env:GOOGLE_OAUTH_CLIENT_ID = "<Google web client id>"
$env:GOOGLE_OAUTH_CLIENT_SECRET = "<Google client secret>"
$env:GOOGLE_OAUTH_REDIRECT_URI = "http://127.0.0.1:8002/v1/gmail/oauth/callback"
$env:GMAIL_TOKEN_ENCRYPTION_KEY = "<base64 encoded 32-byte key>"
$env:GMAIL_TOKEN_PATH = "data/local/gmail-tokens.enc"
$env:GMAIL_LIVE_SEND_ENABLED = "false"
```

The downloaded Google Web application JSON is preferred when
`GOOGLE_OAUTH_CLIENT_JSON_PATH` is set. Its `client_id`, `client_secret`,
`redirect_uris`, `auth_uri`, and `token_uri` are used; the environment client
ID and secret remain a fallback when no JSON path is configured. The selected
configuration must contain the exact callback URI below. Missing, malformed,
unsupported, or unreadable JSON fails closed with a configuration error and
never prints credentials.

In Google Cloud, enable Gmail API, configure the OAuth consent screen, create a
Web application OAuth client, and add exactly
`http://127.0.0.1:8002/v1/gmail/oauth/callback` as an authorized redirect URI.
The application requests `gmail.readonly` for inbox synchronization. The
`gmail.send` scope is requested and validated only when live sending is
explicitly enabled; live sending remains disabled in local setup. Existing
encrypted tokens missing a scope required by the current configuration require
reconnection. Click
**Connect Gmail** in the inbox UI, review the Google account identity shown after
callback, and use **Disconnect** to remove the encrypted local token record.

`GET /v1/gmail/oauth/start` starts the flow and
`GET /v1/gmail/oauth/callback` validates a one-time, expiring server-side state
value before exchanging the authorization code. Tokens are encrypted with
AES-256-GCM when `GMAIL_TOKEN_ENCRYPTION_KEY` and `GMAIL_TOKEN_PATH` are set;
they are never returned by the API. `GET /v1/gmail/status` reports only
configuration and connected-account metadata. Protected routes fail closed
unless they receive an expiring server-issued HttpOnly session cookie or an
authorized service `Authorization: Bearer` session signed with
`TASK2_AUTH_SIGNING_SECRET`. The browser starts Google OpenID Connect at
`/v1/auth/login`; the callback validates issuer, audience, nonce, expiry, RS256
signature, and PKCE state before issuing the cookie. The signed subject is the
only owner identity used for drafts, approvals, Gmail tokens, sync records, and
send attempts; frontend-supplied owner/account IDs are ignored. Health and the
OAuth callbacks are public because Google must redirect to them. The OIDC
callback is `http://127.0.0.1:8002/v1/auth/callback`, distinct from the Gmail
callback `http://127.0.0.1:8002/v1/gmail/oauth/callback` and the authorized
frontend JavaScript origin `http://127.0.0.1:5173`. Do not use
`TASK2_OWNER_ID` as authentication.

`GET /v1/gmail/messages` reads message metadata only when connected.
`POST /v1/gmail/sync` incrementally imports one Gmail page per call into
`GMAIL_SYNC_PATH` (default `data/local/gmail-sync.json`). Stable Gmail message
IDs are unique per owner, retries are idempotent, and
`GET /v1/gmail/messages/local` returns only locally persisted messages.
`GET /v1/gmail/sync/status` exposes sync state and counts without credentials.

After authenticating, `GET /v1/data/export` downloads a ZIP containing all
application data files under the Task 1, Task 2, and Task 3 data directories.
Environment files, OAuth tokens, encrypted Gmail credentials, caches,
dependencies, and build artifacts are intentionally excluded. This is a
complete local workspace backup; per-user filtering is not claimed for the
currently global Task 1 and Task 3 stores.

## Real complaint processing

After Gmail OAuth and synchronization, the frontend can analyze a selected
message through `POST /v1/complaints/{gmailMessageId}/analyze`. The service
fetches the full message body from Gmail, sends it to the configured
server-side Claude provider, validates the structured response, and persists
the original sender, subject, received timestamp, body, analysis, processing
status, and errors in the existing SQLite database. A generated reply is
stored as a normal immutable draft version and remains pending human review.
Edits create a new version and invalidate approval. No automatic send occurs.

Configure `GEMINI_API_KEY` and `GEMINI_MODEL` on the server. Gemini is selected
when either Gemini variable is present; otherwise the legacy Claude adapter is
used when its variables are configured. If the selected provider is missing or
still a placeholder, analysis fails closed with an explicit configuration
error; the UI must not present an AI result. Provider output is treated as
untrusted and must match the validated JSON schema. Never place the key in
frontend variables or logs.
`POST /v1/gmail/send` requires an approved persisted draft and defaults to dry-run;
pass `{"dryRun":false}` only in an explicitly authorized test environment with
`GMAIL_LIVE_SEND_ENABLED=true`. OAuth connection and initial reads never send
mail. Dry-run and disabled-live responses include a `preview` object containing
the recipient, subject, and body that would be sent; they do not call Gmail's
`messages.send` endpoint. Without valid Google credentials, live Gmail behavior
remains blocked and is not claimed. A live request also requires a unique
`idempotencyKey` (or `Idempotency-Key` header). Network or Gmail errors after
the send call are recorded as `outcome_unknown`; the service never blindly retries
them.

### Local PowerShell startup and verification

From the repository root, set the configuration in the same PowerShell session:

```powershell
$env:GOOGLE_OAUTH_CLIENT_JSON_PATH = "C:\Users\<YOUR_WINDOWS_USERNAME>\AppData\Local\Business-Labs\google-oauth-client.json"
# Generate this once, store it in the local .env, and reuse it on future runs.
$env:GMAIL_TOKEN_ENCRYPTION_KEY = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"
$env:GMAIL_LIVE_SEND_ENABLED = "false"
Set-Location task2-inbox-agent
npm run typecheck
npm test
npm start
```

Do not regenerate `GMAIL_TOKEN_ENCRYPTION_KEY` if
`GMAIL_TOKEN_PATH` already contains encrypted tokens; changing the key makes
those tokens unreadable. Rotate only through an explicit migration/reconnect
procedure. The development `.env` currently contains a persistent key value
without exposing it in this documentation.

Start the frontend separately using the repository's existing frontend
commands, then click **Connect Gmail**. After Google's consent screen, verify
that the returned account address is the intended account in the Inbox Agent
panel. Test read-only retrieval through `GET /v1/gmail/messages` before
considering any send test. If Google reports an invalid redirect URI, confirm
that the Cloud Console contains exactly
`http://127.0.0.1:8002/v1/gmail/oauth/callback` and that
`GOOGLE_OAUTH_CLIENT_JSON_PATH` points to the downloaded Web client JSON.
Keep the JSON and encrypted token file outside Git; the repository ignores
common downloaded client-secret names and encrypted token files.

## Checks

From this directory:

```powershell
npm run typecheck
npm test
```

The startup migration can be exercised against a disposable database without
touching local mailbox data:

```powershell
$env:TASK2_DATABASE_URL = "sqlite://$((New-Item -ItemType Directory -Force $env:TEMP\task2-db-test).FullName)\task2.sqlite3"
npm test
```

From the repository root:

```powershell
python run_local.py
```

These checks use deterministic fixtures and local services. They do not call
Claude or send email.
