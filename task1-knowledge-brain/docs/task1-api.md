# Task 1 API Contract

The local development server binds to `127.0.0.1:8001` and does not authenticate. It must not be exposed outside the local machine. A deployed boundary must add TLS, authentication, authorization, and request limits. Clients may send `X-Request-ID`; otherwise the service generates a `req_<uuid>` value and returns it in both the response header and body where a body exists.

All request bodies are JSON objects. Responses are JSON. The service rejects bodies larger than 1 MB.

## `GET /health`

Returns `200`:

```json
{
  "status": "ok",
  "service": "task1-knowledge-brain"
}
```

## `POST /query`

Request fields:

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `question` | string | yes | Non-empty user question, at most 10,000 characters |

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `answer` | string or null | Grounded answer, or null when evidence is insufficient/unavailable |
| `status` | string | `answered`, `insufficient_evidence`, `retrieval_unavailable`, or another documented service state |
| `sources` | array | Citation objects supporting the answer |
| `image_references` | array of strings | Relevant source image URLs/references |
| `human_help_needed` | boolean | Whether a human should review the request |
| `request_id` | string | Correlation identifier |
| `retrieval_trace` | array of strings | Safe retrieval diagnostics; never secrets or unnecessary personal data |

Citation fields are `title` (string), `url` (string), `section` (string or null), and `chunk_id` (string or null). There is deliberately no confidence field because confidence is not calibrated.

`200` is used for `answered` and explicit `insufficient_evidence` results. `503` indicates an unavailable model or retrieval service. `504` indicates the configured query timeout. The service must not fabricate an answer for either failure state.

## Sitemap management

Sitemap management is persisted in the same SQLite database as the ingestion
manifest. The current local boundary uses an explicit `owner_id` field; it is
not an authentication mechanism and the service must remain loopback-only until
an authenticated gateway is deployed.

### `POST /sitemaps`

Creates an owned sitemap configuration. The root URL must be HTTP or HTTPS,
must not contain credentials, and must not resolve to a loopback, private,
reserved, link-local, or cloud-metadata address.

```json
{
  "owner_id": "demo-user",
  "root_url": "https://docs.example.com/sitemap.xml",
  "interval": "daily",
  "threshold": 3,
  "action": "review"
}
```

Allowed intervals are `daily`, `weekly`, `15-days`, and `30-days`. Allowed
actions are `review`, `quarantine`, and `archive`; thresholds are `1`, `2`,
`3`, `7`, `15`, and `30`.

### `POST /sitemaps/list`

Returns active configurations for the supplied `owner_id`.

### `POST /sitemaps/{id}/refresh`

Runs a bounded, idempotent refresh for one sitemap. The response includes
start/end timestamps, listed and unique URL totals, duplicate counts, error
counts, processed/total page counts, and safe error summaries. Sitemap
membership is stored separately from page HTTP status.

### `POST /sitemaps/{id}/runs`

Returns recent refresh history for the owner.

### `POST /sitemaps/{id}/pending`

Returns URLs approaching their configured threshold, including current count,
threshold, lifecycle status, reason, and intended action. Failed sitemap
discovery does not increment missing checks.

### `POST /sitemaps/{id}/urls`

Returns persisted URL-level results for a refresh. Supply `run_id` to select a
specific run, plus optional `limit` (1-2000) and `offset` for bounded loading.
Each result reports fetch status, HTTP status when available, sitemap
membership, lifecycle state, fetch timestamp, and a safe error summary.

The local server runs a dependency-free background scheduler. It polls due
configurations, prevents overlapping refreshes per sitemap, records failures,
and computes the next run from the selected interval. Historical article
versions and URL records are retained; quarantine/archive actions do not
delete them.

## `POST /ingestion/run`

Starts or reports an ingestion run. The current foundation delegates this to the injected ingestion service.

Response fields are `state`, `run_id`, `added`, `updated`, `unchanged`, `removed`, `failed`, and `error`. Counts are integers; `run_id` and `error` may be null.

## `GET /ingestion/status`

Returns the same ingestion status object as `/ingestion/run` without starting a new run.

## `POST /escalations`

Request fields:

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `question` | string | yes | Question needing human review |
| `reason` | string | yes | Review reason, such as insufficient evidence or service failure |
| `evidence` | citation array | no | Relevant retrieved evidence |

The `201` response contains `escalation_id`, `question`, `reason`, `evidence`, `status`, `created_at`, `resolved_at`, `reviewer_answer`, and `request_id`.

## `POST /escalations/{id}/resolve`

Request fields:

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `answer` | string | yes | Reviewer-provided answer |
| `reviewer` | string | yes | Reviewer identity in the local boundary |

The `200` response returns the escalation with `status: resolved`, `resolved_at`, and `reviewer_answer`. A missing ID returns `404 escalation_not_found`. Expert-answer versioning, expiry, and authorization policy are implemented in the escalation workflow phase, not inferred from this foundation contract.

## Error object

```json
{
  "error": "invalid_request",
  "message": "Human-readable safe message",
  "request_id": "req_..."
}
```

Defined error codes are `invalid_body`, `invalid_json`, `invalid_request`, `method_not_allowed`, `not_found`, `escalation_not_found`, `model_unavailable`, `retrieval_unavailable`, `service_unavailable`, `service_timeout`, and `internal_error`.
