# Foundation Design

## Scope

This change establishes the repository boundary only. Task behavior, model calls, retrieval, UI workflows, and evaluation runs are intentionally not implemented yet.

## Services

`task1-knowledge-brain` is a Python service owner for sitemap ingestion, article and image processing, chunking, embeddings, retrieval, RAG answers, citations, escalation, and the daily update job. Its current public boundary is the documented local WSGI HTTP API in `task1-knowledge-brain/docs/`.

`task2-inbox-agent` is a TypeScript service owner for synthetic email fixtures, classification, grounded drafting, human review, feedback history, and the 20-consecutive-unchanged-draft policy. It must call Task 1 through HTTP and must not import Task 1 retrieval code.

`task3-meeting-to-scope` is a Python service owner for transcript analysis, source-linked requirements, Task 1 feasibility calls, scope, estimates, proposals, approved baselines, and change reports. It must call Task 1 through HTTP and must not duplicate its retrieval pipeline.

Each task has its own dependency manifest and environment. No task mixes Python and TypeScript code.

## Storage boundary

The planned local-first storage is SQLite for service metadata and a persistent vector store owned only by Task 1. Local databases and generated data are ignored by Git. Task 2 and Task 3 will receive knowledge results only through the Task 1 API.

The `shared/` directory contains contracts, fixtures, and evaluation data boundaries, not service implementation or shared retrieval logic.

## Model and safety boundary

Claude is the central model family. Model configuration will be injected through environment/configuration adapters. Secrets will not be stored in source control. Model output must be schema-validated before it can enter a workflow.

Human review remains authoritative for email actions, escalations, and proposal approval. Retrieved pages, emails, and transcripts are untrusted data and must not override system instructions or policy controls.

## Validation boundary

The foundation currently provides health checks and test discovery scaffolding only. Future implementation must add at least 20 test cases per task, compare the required model/configuration choices, and record actual quality, cost, and latency results in `EVALS.md`.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Python service framework | FastAPI-compatible foundation, added later with the service implementation | Keeps API ownership explicit without adding unfinished application code now |
| TypeScript runtime | Node.js with TypeScript | Meets the Inbox Agent requirement and keeps its environment separate |
| Local metadata | SQLite | Smallest useful persistent local store for a capstone |
| Vector ownership | Task 1 only | Enforces the no-duplicate-retrieval requirement |
| Cross-task boundary | Versioned HTTP API | Makes integration testable and prevents shared retrieval imports |
| Model family | Claude via configuration | Required by the brief; no model results are claimed here |
| UI scope | Small review surfaces added with application work | Avoids creating UI placeholders that imply unsupported behavior |