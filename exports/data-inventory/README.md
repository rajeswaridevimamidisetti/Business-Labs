# AI IT Consultant - Complete Data Inventory

**Generated:** 2026-10-23T21:19:25Z
**Total tables/datasets:** 19
**Total records exported:** 2,079

---

## Databases

### 1. manifest.sqlite3 (Task 1 - Knowledge Brain)
Location: `task1-knowledge-brain/data/manifest.sqlite3`
CSV exports: `csv/task1/`

| Table | Rows | Purpose |
|-------|------|---------|
| sitemap_configs | 5 | Sitemap monitoring configurations |
| sitemap_imports | 3 | Sitemap crawl import history |
| sitemap_membership | 0 | URL-sitemap membership (empty) |
| sitemap_refresh_runs | 22 | Per-run refresh history |
| sitemap_refresh_urls | 0 | Per-URL fetch results (empty) |
| sitemap_rejected_urls | 0 | Rejected URLs (empty) |
| sitemap_source_urls | 1,699 | All discovered sitemap URLs |
| sources | 50 | Article source lifecycle tracking |
| article_versions | 100 | Stored article content snapshots |

### 2. task2.sqlite3 (Task 2 - Inbox Agent)
Location: `task2-inbox-agent/data/local/task2.sqlite3`
CSV exports: `csv/task2/`

| Table | Rows | Purpose |
|-------|------|---------|
| email_drafts | 21 | AI-generated draft replies |
| draft_audit_events | 21 | Draft event audit trail |
| complaint_records | 0 | Parsed complaint emails (empty) |
| send_attempts | 0 | Send attempt log (empty) |
| schema_migrations | 1 | DB migration version |

---

## JSON / File Data

### Task 2 - Gmail Sync (files/reports/gmail-sync.json)
- **gmail_messages.csv** - Gmail message metadata. Body/snippet REDACTED.
- **gmail_sync_states.csv** - OAuth sync state. Token REDACTED.

### Task 2 - Feedback (files/reports/task2-feedback.json)
- **feedback_events.csv** - Human feedback events on AI drafts.

### Task 3 - Proposals (csv/task3/proposals.csv)
- Scope proposals generated from meeting transcripts.

### Shared - Evaluations (files/reports/offline-*.json)
- Offline evaluation run results.

---

## Sitemap Files (files/sitemap/)

| File | Content |
|------|---------|
| sitemap-urls.txt | 1,699 sitemap URLs |
| article-urls.txt | 1,540 article URLs |
| sitemap-extraction-report.json | Extraction summary |

---

## How to Open

- **CSV files** - Excel, LibreOffice, or any text editor. UTF-8 encoded.
- **Excel workbook** - Open AI_IT_Consultant_Data_Inventory.xlsx with Excel 2016+ or LibreOffice Calc.
- **JSON files** - Any text editor or JSON viewer (VS Code, jq).
- **SQL schema** - Any text editor or SQLite browser.

---

## Security

- No .env files, API keys, OAuth tokens, or secrets included
- Gmail message body/snippet REDACTED
- Gmail OAuth token REDACTED
- No raw database file copies (SQL schema + CSV exports instead)
- No node_modules, .venv, or build caches

---

## Archive Structure

```
AI_IT_Consultant_Complete_Data_Inventory.zip
├── README.md
├── AI_IT_Consultant_Data_Inventory.xlsx
├── export_manifest.json
├── database_schema.sql
├── databases/
│   └── database_metadata.json
├── csv/
│   ├── task1/   (9 CSV files - Task1 SQLite tables)
│   ├── task2/   (Task2 SQLite + Gmail + feedback CSVs)
│   ├── task3/   (proposals.csv + proposals.json)
│   └── other/
├── files/
│   ├── sitemap/ (sitemap-urls.txt, article-urls.txt, extraction-report.json)
│   └── reports/ (gmail-sync.json, task2-feedback.json, evaluation.json)
```
