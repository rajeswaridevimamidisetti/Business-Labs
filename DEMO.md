# Demo Runbook

This script uses only functionality currently present and does not stage live model scores.

## Setup

```bash
python run_local.py
cd task1-knowledge-brain && PYTHONPATH=src python -m unittest discover -s tests
cd ../task2-inbox-agent && npm install && npm run typecheck && npm test
cd ../task3-meeting-to-scope && PYTHONPATH=src python -m unittest discover -s tests
```

## Ten-minute flow

1. Show the three task directories and explain that Task 2 and Task 3 use the Task 1 HTTP contract.
2. Run Task 1 fixture tests and show citations, abstention, escalation, and ingestion failure-state tests.
3. Show a synthetic inbox email, typed classification, evidence-grounded draft, review actions, and the 20-case tracker with its kill switch.
4. Load the three synthetic Task 3 transcripts, show source-linked requirements, feasibility results, estimates, proposal approval, and follow-up change comparison.
5. Show actual deterministic totals: Task 1 36 tests, Task 2 11 tests, Task 3 7 tests.
6. Show the genuine limitation: Claude comparisons, human-reference estimates, live end-to-end deployment, and real vision calls are pending.

Do not claim that the default Task 1 server answers live knowledge questions; its default injected services report unavailable until configured.
