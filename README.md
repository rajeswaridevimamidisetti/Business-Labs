# Business Labs

AI Tech Consultant capstone with Task 1 knowledge services, Task 2 inbox workflow, and Task 3 meeting-to-scope workflow. Model-backed evaluation remains pending unless explicitly recorded in `EVALS.md`.

## Layout

- `task1-knowledge-brain/`: Python Knowledge Brain environment and health-check scaffold.
- `task2-inbox-agent/`: TypeScript Inbox Agent environment and health-check scaffold.
- `task3-meeting-to-scope/`: Python Meeting to Scope environment and health-check scaffold.
- `shared/`: documentation, test fixtures, and evaluation data boundaries.
- `DESIGN.md`: approved foundation architecture and boundaries.
- `TRACEABILITY.md`: requirement-to-evidence mapping.
- `EVALS.md`: evaluation plan; no results are claimed yet.
- `AI_LOG.md`: concise implementation log.
- `DEMO.md`: truthful demo runbook.
- `AUDIT.md`: final requirement audit and remaining blockers.

## Local setup

Secrets stay local. Copy `.env.example` to `.env` and replace placeholders without committing the copy.

Create separate Python environments:

```bash
cd task1-knowledge-brain && python3 -m venv .venv && . .venv/bin/activate && python -m pip install -e '.[test]'
cd ../task3-meeting-to-scope && python3 -m venv .venv && . .venv/bin/activate && python -m pip install -e '.[test]'
```

Install and check the TypeScript task separately:

```bash
cd task2-inbox-agent
npm install
npm run typecheck
npm test
```

The Python health checks can be run without external services:

```bash
cd task1-knowledge-brain && python -m unittest discover -s tests
cd ../task3-meeting-to-scope && python -m unittest discover -s tests
```

These commands validate deterministic behavior. They do not run live Claude calls or claim evaluation results.

Run the repository readiness check with:

```bash
python run_local.py
```

Task 1's public API is documented in `task1-knowledge-brain/docs/task1-api.md`; Tasks 2 and 3 use that HTTP contract rather than importing Task 1 internals.