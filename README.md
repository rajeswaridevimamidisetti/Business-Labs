# Business Labs

AI Tech Consultant capstone with Task 1 knowledge services, Task 2 inbox workflow, and Task 3 meeting-to-scope workflow. Model-backed evaluation remains pending unless explicitly recorded in `EVALS.md`.

## Layout

- `task1-knowledge-brain/`: Python Knowledge Brain environment and health-check scaffold.
- `task2-inbox-agent/`: TypeScript Inbox Agent environment and health-check scaffold.
- `task2-inbox-agent/README.md`: Task 2 dataset, evidence, review, audit, and eligibility behavior.
- `task3-meeting-to-scope/`: Python Meeting to Scope environment and health-check scaffold.
- `shared/`: documentation, test fixtures, and evaluation data boundaries.
- `DESIGN.md`: approved foundation architecture and boundaries.
- `TRACEABILITY.md`: requirement-to-evidence mapping.
- `EVALS.md`: evaluation plan; no results are claimed yet.
- `evaluator/`: separate live Claude evaluation runner and mocked tests.
- `AI_LOG.md`: concise implementation log.
- `DEMO.md`: truthful demo runbook.
- `AUDIT.md`: final requirement audit and remaining blockers.

## Local setup

Secrets stay local. Copy `.env.example` to `.env` and replace placeholders without committing the copy.

Create separate Python environments (PowerShell):

```bash
cd task1-knowledge-brain
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
cd ..\task3-meeting-to-scope
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
```

Install and check the TypeScript task separately:

```bash
cd task2-inbox-agent
npm install
npm run typecheck
npm test
```

The Python test suites are run from their own package roots:

```bash
cd task1-knowledge-brain
.\.venv\Scripts\python.exe -m pytest -q
cd ..\task3-meeting-to-scope
$env:PYTHONPATH="src"
python -m unittest discover -s tests
```

These commands validate deterministic behavior. They do not run live Claude calls or claim evaluation results.

## Live Claude evaluation

Live evaluation is intentionally separate from the deterministic test suites
and fixture-based retrieval tests. Install the official Anthropic Python SDK,
then set `CLAUDE_API_KEY` and `CLAUDE_MODEL` in the current PowerShell
session without printing the key:

```powershell
python -m pip install -r evaluator\requirements.txt
python evaluator\live_claude_eval.py --dry-run
python evaluator\live_claude_eval.py
```

The final command requires the three local services to be running. It uses
the existing Task 1, Task 2, and Task 3 HTTP interfaces, sends each returned
application result to Claude for structured provisional scoring, and writes
actual responses, usage, latency, errors, and optional cost estimates to a
new timestamped file in `shared\evaluations\`. It does not overwrite prior
runs. Missing credentials or an uninstalled SDK stops before any API call.

Start all three backend services and keep them running with:

```bash
python run_local.py --serve
```

Start the complete backend and frontend stack with one command:

```powershell
python run_local.py --full-stack --serve
```

This checks the required local ports and installed Node dependencies, starts
Task 1, Task 2, Task 3, and Vite, prints all service URLs, and shuts down the
child processes when interrupted. Install frontend and Task 2 dependencies
first with `npm install` in each respective directory.

Then start the browser console in a second PowerShell window:

```

Run the deterministic evaluation inventory without contacting Claude:

```powershell
python evaluator\offline_eval.py
```

This verifies 20 cases per task, preserves each case's pending provider status,
and writes a timestamped `offline-*.json` evidence file under
`shared\evaluations\`. It records no model scores, costs, or latency.bash
cd frontend
npm install
npm run dev
```

For a one-shot integration check that starts the services, exercises the
cross-task routes, and shuts them down automatically, run `python run_local.py`
without `--serve`.

Task 1's public API is documented in `task1-knowledge-brain/docs/task1-api.md`;
Tasks 2 and 3 use that HTTP contract rather than importing Task 1 internals.
Task 2 exposes `/v1/emails`, `/v1/drafts`, and `/v1/reviews`; Task 3 exposes
`/v1/transcripts`, `/v1/scope`, and proposal approval routes for the console.