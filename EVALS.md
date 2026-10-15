# Evaluation Plan

No evaluation has been run. This file records the required evidence shape only.

## Required coverage

- At least 20 test cases for each task.
- At least two Claude model/configuration choices where required by the brief.
- Quality measured with an explicit rubric.
- Cost measured from recorded usage and declared pricing inputs.
- Latency measured from timed calls with the execution environment recorded.
- Deterministic tests separated from model evaluations.
- Task 2 and Task 3 integration evidence showing Task 1 API use without retrieval duplication.
- Task 3 has 20 pending cases covering extraction, feasibility, scope, estimates, proposals, follow-up changes, and approval enforcement.

## Result record

Future runs should record case ID, task, model/configuration ID, input fixture, output or output reference, quality score, token usage, cost, latency, timestamp, and error state. Unavailable provider runs must be marked unavailable. No placeholder numbers are valid evaluation results.

## Current status

Deterministic tests for all three tasks have run, and the local three-service HTTP smoke test passes. No live Claude comparison, human-reviewed reference set, or real provider cost has been recorded. Those comparisons remain `pending`.