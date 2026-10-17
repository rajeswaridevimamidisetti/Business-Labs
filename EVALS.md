# Evaluation Plan

The live evaluator is separate from deterministic tests and fixture-based
retrieval tests. It calls each task's documented local HTTP interface, then
uses Anthropic's official Python SDK to produce a provisional structured
judgment. It never writes placeholder scores.

## Setup and usage (Windows PowerShell)

From the repository root, install the evaluator dependency:

```powershell
python -m pip install -r evaluator\requirements.txt
```

Set secrets only in the current PowerShell session or in an ignored local
`.env` loaded by the user's shell. Do not print the key:

```powershell
$env:CLAUDE_API_KEY = "<your-local-key>"
$env:CLAUDE_MODEL = "<approved-claude-model>"
```

Validate the case inventory without contacting any service or Claude:

```powershell
python evaluator\live_claude_eval.py --dry-run
```

Run the offline deterministic inventory and write timestamped evidence:

```powershell
python evaluator\offline_eval.py
```

This executes inventory assertions for 20 cases per task and writes a new
`offline-*.json` file with `provider_called: false`. It does not produce
Claude quality, cost, or latency results.

After the three local services are running, execute the live evaluation:

```powershell
python evaluator\live_claude_eval.py
```

Each run creates a new UTC-timestamped JSON file under
`shared\evaluations\`. Existing result files are never overwritten. A result
with `status: "executed"` means the application interface returned and Claude
returned a valid JSON judgment. Scores are marked `provisional` because
automated judging is not human review.

## Required coverage

- At least 20 test cases for each task.
- At least two Claude model/configuration choices where required by the brief.
- Quality measured with an explicit rubric.
- Cost measured from recorded usage and declared pricing inputs.
- Latency measured from timed calls with the execution environment recorded.
- Deterministic tests separated from model evaluations.
- Task 2 and Task 3 integration evidence showing Task 1 API use without retrieval duplication.
- Task 3 has 20 complete deterministic cases covering extraction, feasibility, scope, estimates, proposals, follow-up changes, and approval enforcement. Their provider evaluation status remains pending until an actual model evaluation is executed.

## Result record

Future runs should record case ID, task, model/configuration ID, input fixture, output or output reference, quality score, token usage, cost, latency, timestamp, and error state. Unavailable provider runs must be marked unavailable. No placeholder numbers are valid evaluation results.

## Current status

Deterministic tests for all three tasks have run, and the local three-service HTTP smoke test passes. No live Claude comparison, human-reviewed reference set, or real provider cost has been recorded. Those comparisons remain `pending`.

The evaluator itself has mocked unit tests. A live run remains pending until
the user supplies a valid local key/model, starts the services, and runs the
command above.