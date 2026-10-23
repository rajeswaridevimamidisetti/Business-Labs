# Local Runbook

This script starts the local services without enabling Gmail live sending.

## Setup

```bash
python run_local.py
cd task1-knowledge-brain && PYTHONPATH=src python -m unittest discover -s tests
cd ../task2-inbox-agent && npm install && npm run typecheck && npm test
cd ../task3-meeting-to-scope && PYTHONPATH=src python -m unittest discover -s tests
```

For the browser application, use the full-stack launcher:

```bash
python run_local.py --full-stack --serve
```

The launcher forces `GMAIL_LIVE_SEND_ENABLED=false`. Protected routes require
an authenticated gateway bearer session. Configure Google OAuth and the
encrypted token store in Task 2 before connecting a real Gmail account.

## Ten-minute flow

1. Show the three task directories and explain that Task 2 and Task 3 use the Task 1 HTTP contract.
2. Run Task 1 tests and show citations, abstention, escalation, and ingestion failure-state tests.
3. Connect an authenticated Gmail account, sync its real messages, and review an evidence-grounded draft without sending.
4. Load Task 3 transcript examples, show source-linked requirements, feasibility results, estimates, proposal approval, and follow-up change comparison.
5. Show actual deterministic totals: Task 1 36 tests, Task 2 11 tests, Task 3 7 tests.
6. Show the genuine limitation: Claude comparisons, human-reference estimates, live end-to-end deployment, and real vision calls are pending.

Do not claim that the default Task 1 server answers live knowledge questions; its default injected services report unavailable until configured.
