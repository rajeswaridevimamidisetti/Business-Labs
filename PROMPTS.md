# AI Tech Consultant: GitHub Copilot Prompt Pack

Use these prompts in order in GitHub Copilot Chat Agent mode. After each prompt, inspect the diff, run the requested checks, and record the interaction in `AI_LOG.md`. Do not move on while the acceptance checks fail.

## 0. Repository contract and plan

```text
You are the lead engineer for this assignment. Inspect the repository and create a minimal, maintainable monorepo for three tasks:

1. Python Knowledge Brain: crawl https://support.brilliantdirectories.com/support/sitemap.xml, include useful page images/screenshots in ingestion, support daily incremental updates, answer with RAG citations, escalate uncertain or unsafe requests to a human, and expose a documented HTTP API.
2. TypeScript Inbox Agent: generate at least 50 realistic synthetic emails, classify and draft typed replies, call Task 1 only through its API, support human edit/approve/reject, store feedback history, and implement the 20-consecutive-unchanged-draft eligibility rule with safety controls.
3. Python Meeting to Scope: process at least three role-played transcripts, including a follow-up to the first, produce source-linked requirements, call Task 1 for feasibility checks, create scope/estimates/proposals, compare revisions to an approved baseline, and require human approval.

Choose a simple local-first architecture and document it in DESIGN.md. Keep secrets out of source control. Add placeholder interfaces only where an external model or service is required; do not fake completed behavior or evaluation results. Create a focused test strategy with at least 20 cases per task. Before editing, explain the proposed directory tree and the commands you will use to validate it.
```

## 1. Scaffold and quality gates

```text
Implement the repository structure from the approved design. Add reproducible setup commands, environment-variable templates, formatting/type-checking/linting configuration, and CI checks if appropriate. Add a small health-check or smoke test for each task. Make all network, model, and storage dependencies injectable so tests can run deterministically without secrets or paid services. Do not add invented benchmark numbers. Run the narrowest available checks and report their actual output.
```

## 2. Knowledge Brain ingestion and retrieval

```text
Implement Task 1 end to end. The sitemap at https://support.brilliantdirectories.com/support/sitemap.xml is the crawl root. Add URL validation, robots/rate-limit awareness, retries, content hashing, source metadata, and a persistent crawl state so a daily run processes only new or changed pages. Extract image URLs and accessible image text/metadata; make the image handling explicit in the design and tests. Build retrieval with chunk-level source references including URL, title, and relevant section or image reference. Add an answer service that refuses unsupported claims, returns citations, and produces a human-escalation result when confidence, policy, or retrieval quality is insufficient. Expose documented API endpoints for ingestion status, query, and escalation. Add at least 20 deterministic Task 1 tests, including changed/deleted URLs, duplicate content, malformed sitemap input, citation coverage, prompt injection in retrieved text, image metadata, and escalation. Run them and report only measured results.
```

## 3. Inbox Agent

```text
Implement Task 2 against the documented Task 1 HTTP API client. Do not import or duplicate Task 1 retrieval code. Add at least 50 realistic synthetic emails covering routine, ambiguous, sensitive, malicious, and out-of-scope cases. Use runtime-validated typed input/output schemas for classification, retrieved context, draft, confidence, citations, and review status. Implement human edit, approve, reject, and escalation flows with an auditable feedback history.

Implement the eligibility rule exactly: a draft is eligible only after 20 consecutive qualifying examples whose approved human result is unchanged from the generated draft under a clearly documented canonical comparison. Reset the streak on any changed, rejected, escalated, or invalid example. Add safety controls: never auto-send, block sensitive categories, require current cited context, support rollback, and make the threshold configurable only in tests or explicit policy configuration. Add at least 20 Task 2 tests, including streak boundaries at 19/20/21, reset behavior, whitespace/canonicalization, policy blocks, API failures, edited approvals, and audit records. Run the tests and report actual counts and failures.
```

## 4. Meeting to Scope

```text
Implement Task 3 against the documented Task 1 HTTP API client. Do not duplicate Task 1 retrieval or vector-search implementation. Add at least three role-played transcript fixtures, with a follow-up transcript linked to the first meeting. Extract requirements with speaker/source-span references and explicit uncertainty. Run feasibility checks through Task 1 and preserve those citations in the result. Produce scope, assumptions, dependencies, estimates with a stated method, and a proposal. Store an approved baseline and require human approval before it becomes authoritative. For later revisions, show additions, removals, and changed estimates compared with that baseline.

Add at least 20 Task 3 tests, including source-span mapping, follow-up continuity, contradictory statements, missing details, Task 1 timeout/error, feasibility citations, estimate calculation, baseline diff, approval/rejection, and unchanged revisions. Run the tests and report actual output only.
```

## 5. Evaluation harness

```text
Build evaluation harnesses for all three tasks with at least 20 cases per task. Compare at least two genuinely different model/configuration choices where the task requires it, using the same fixtures and acceptance criteria. Measure quality with explicit rubrics, cost from recorded token/provider pricing data, and latency from timed calls. Separate deterministic unit-test results from model evaluation results. Store raw outputs and configuration identifiers without secrets. Generate EVALS.md from measured runs only; if a provider is unavailable, mark that run unavailable rather than fabricating a score. Add regression checks for citations, human review gates, API-only cross-task calls, and the 20-consecutive-unchanged-draft rule.
```

## 6. Documentation and demo readiness

```text
Review the repository against the assignment. Bring README.md to one page with setup, run, test, API, and demo commands. Keep DESIGN.md between 3 and 5 pages and EVALS.md between 2 and 3 pages when rendered. Keep AI_LOG.md to one page containing concise prompt/run decisions and actual validation evidence. Check that no secrets, fabricated results, duplicate Task 1 retrieval code, or undocumented human-approval bypasses remain. Run the complete available test and evaluation commands, inspect the final diff, and list any unverified external-service limitations instead of claiming success.
```

## Suggested interaction log format

For each prompt, record the date, prompt number, files changed, command(s) run, measured result, and unresolved limitation in `AI_LOG.md`. Keep the log concise enough to fit the submission limit.