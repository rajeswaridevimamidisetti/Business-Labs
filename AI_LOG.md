# AI Log

## Foundation

- 2026-10-15: Inspected the repository. Preserved `PROMPTS.md`; the repository had only a title-only `README.md`.
- 2026-10-15: Added separate task environments, root configuration, documentation boundaries, health checks, and test scaffolding.
- Validation: `cd task1-knowledge-brain && PYTHONPATH=src python -m unittest discover -s tests` passed: 1 test, 0 failures.
- Validation: `cd task3-meeting-to-scope && PYTHONPATH=src python -m unittest discover -s tests` passed: 1 test, 0 failures.
- Validation: `npm --prefix task2-inbox-agent test` could not run because `node_modules` is absent; Node reported `Cannot find package 'tsx'`. No dependencies were installed.
- 2026-10-15: Inspected the live sitemap document only. It parsed as `urlset` with 1,696 accepted URLs, 0 child sitemaps, and 0 skipped URLs; no linked pages were crawled.
- 2026-10-15: Added Task 1 sitemap parsing, safe host validation, skip reasons, and local XML fixtures.
- Validation: `PYTHONPATH=src python -m unittest discover -s tests` passed: 8 tests, 0 failures.
- 2026-10-15: Added the bounded Task 1 crawl runner with SQLite manifest/content-version persistence, retries, rate limiting, robots checks, checkpoint state, failure isolation, and inactive removal marking.
- Validation: `PYTHONPATH=src python -m unittest discover -s tests` passed: 16 tests, 0 failures. No article crawl was run against the live site.
- 2026-10-15: Inspected one live article URL. It returned a redirect shell with navigation/scripts rather than a usable article body, so article extraction coverage uses offline HTML fixtures; no further article URLs were fetched.
- 2026-10-15: Added normalized article extraction with structure, tables, lists, image references, canonical URL, metadata, content hash, JSON output, and low-quality warnings.
- Validation: `PYTHONPATH=src python -m unittest discover -s tests` passed: 21 tests, 0 failures.
- 2026-10-15: Implemented the independent Task 1 HTTP API contract with WSGI adapter, request IDs, validation, timeout/error handling, health, ingestion, query, and escalation endpoints plus OpenAPI documentation.
- Validation: `python -m json.tool docs/task1-openapi.json`, `PYTHONPATH=src python -m unittest discover -s tests`, `python -m compileall -q src`, and `git diff --check` passed. Test result: 29 tests, 0 failures.
- 2026-10-15: Added Task 1 image, chunking, retrieval, grounded-answer, versioned expert-escalation, daily-operation, and pending evaluation interfaces.
- Validation: `PYTHONPATH=src python -m unittest discover -s tests` passed: 36 tests, 0 failures.
- 2026-10-15: Added Task 2 typed schemas, 50 synthetic emails with held-out cases, Task 1 HTTP client, classification fallback, evidence-grounded drafts, review UI rendering, feedback aggregation, prompt revision gate, 20-case eligibility tracker, kill switch, and pending evaluation cases.
- Validation: `npm --prefix task2-inbox-agent run typecheck` passed; `npm --prefix task2-inbox-agent test` passed: 11 tests, 0 failures. No live Claude evaluation or human-review metric was run.
- 2026-10-15: Added Task 3 synthetic transcripts, staged requirement/feasibility/scope/estimate/proposal modules, public Task 1 HTTP client, follow-up comparison, approval gate, UI renderer, and pending evaluation cases.
- Validation: `PYTHONPATH=task3-meeting-to-scope/src python -m unittest discover -s task3-meeting-to-scope/tests -t task3-meeting-to-scope` passed: 7 tests, 0 failures.
- Rejected generated work example: an initial review workflow allowed a second finalization after an edit; its failing test exposed the unsafe transition, so the implementation was changed to reject every second terminal review action.
- 2026-10-15: Replaced readiness-only startup with safe deterministic Task 1, Task 2, and Task 3 HTTP smoke services; added local persistence for Task 2 feedback and Task 3 proposal approvals.
- Validation: `python run_local.py` passed: Task 2 and Task 3 obtained evidence through Task 1 and all processes shut down. Task 2 passed 22 tests; Task 3 passed 20 tests.
- 2026-10-17: Added the separate `evaluator/live_claude_eval.py` runner using Anthropic's official Python SDK. It loads the existing 20 cases for each task, calls the documented HTTP interfaces, records provisional Claude judgments, usage, latency, errors, and optional cost in new timestamped files.
- Validation: evaluator mocked tests passed: 3 tests; dry run loaded 60 cases without API calls; missing-key mode stopped before provider calls. Existing suites remained green: Task 1 37 tests, Task 2 25 tests, Task 3 20 tests.