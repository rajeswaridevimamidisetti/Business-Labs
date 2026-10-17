# Task 2 Inbox Agent

## Current workflow

The local service exposes backend-provided synthetic emails, generates a
draft through the Task 1 HTTP contract, and records review actions. The
browser console uses the same `/v1/emails`, `/v1/drafts`, and `/v1/reviews`
routes through the Vite proxy.

The dataset contains 50 cases:

| Category | Count |
|---|---:|
| How-to | 12 |
| Troubleshooting | 10 |
| Project request | 6 |
| Refund/cancellation | 6 |
| Complaint | 6 |
| Quote request | 5 |
| Follow-up | 5 |

Forty cases are development cases and ten are held out. Each case has a
stable ID, varied subject/message, expected category and outcome, important
facts, evidence expectation, risk, and expected handling.

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

The 20-case eligibility tracker is a separate, durable state machine in
`src/eligibility.ts`. It counts only explicit `sent` events with unchanged
content, low risk, and a passing quality check. Approval alone cannot qualify
a category. Autonomy is disabled unless an authorized delivery integration
explicitly emits a sent event; the current service has no such integration.

## Checks

From this directory:

```powershell
npm run typecheck
npm test
```

From the repository root:

```powershell
python run_local.py
```

These checks use deterministic fixtures and local services. They do not call
Claude or send email.
