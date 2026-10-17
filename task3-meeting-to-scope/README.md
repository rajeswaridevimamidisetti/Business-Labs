# Task 3 Meeting to Scope

## Workflow

The service exposes a deterministic, evidence-preserving workflow:

1. `TranscriptAnalyst` parses speaker and timestamp segments and extracts
   traceable requirements.
2. `ProductFeasibilityAgent` queries Task 1 through its public HTTP API.
3. `ScopeAgent` creates a structured scope with requirement-specific
   acceptance criteria.
4. `EstimationAgent` creates task-level low, likely, and high estimates.
5. `ProposalReviewAgent` creates a versioned proposal that remains pending
   until a reviewer approves it.

The first scope request is:

```text
POST /v1/scope
```

It persists the proposal version and returns requirements, feasibility,
estimates, proposal data, and `changes: null` for an initial scope.

Approve a version with:

```text
POST /v1/proposals/{proposal_id}/approve
{"reviewer":"reviewer-id"}
```

Approval records the reviewer and UTC approval timestamp.

## Follow-up change control

After an initial proposal is approved, submit a follow-up transcript with:

```text
POST /v1/scope/follow-up
{
  "project_id": "website-refresh",
  "meeting_id": "meeting-3",
  "date": "2026-01-17",
  "transcript": "Client: Add saved filters."
}
```

The endpoint loads the persisted approved baseline, creates the next proposal
version, recalculates estimates, and returns a real change report. The revised
proposal starts as `pending`; it must be approved separately. A missing
approved baseline returns `409 approved_baseline_required`.

Proposal JSON is stored at `data/proposals.json` by default. Override it with
`TASK3_PROPOSAL_STORE`. Writes use a temporary file replacement so an earlier
valid store is not silently discarded.

## Evaluation and limitations

`meeting_to_scope.evals.default_cases()` contains 20 complete deterministic
evaluation fixtures with transcripts and assertions. They are not live model
results. Claude evaluation remains separate and is only complete after an
actual provider run is recorded in `shared/evaluations/`.

There is no external proposal delivery integration. Approval only makes a
proposal eligible for an explicitly implemented delivery integration; the
current local service does not send proposals.

## Checks

```powershell
cd task3-meeting-to-scope
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```
