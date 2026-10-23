# Task 1 Knowledge Brain

Local setup:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
PYTHONPATH=src python -m unittest discover -s tests
```

Run the local-only API:

```bash
PYTHONPATH=src python -m knowledge_brain.server
```

The API contract is documented in `docs/task1-api.md` and `docs/task1-openapi.json`. The server has no authentication and must remain bound to loopback.

The production crawler defaults to the Brilliant Directories support sitemap and
selects URLs containing `/support/solutions/articles/`. `TASK1_MAX_ARTICLES=0`
means unlimited eligible article URLs; set a positive value only for a deliberate
bounded run. `TASK1_ARTICLE_PATH_FRAGMENT` can be changed for another approved
source format. Sitemap refresh configuration persists threshold and action rules
in SQLite and exposes refresh history, URL outcomes, and pending lifecycle items
through the sitemap API.

The local Task 1 API is intentionally loopback-only and does not provide identity
authentication. Do not expose port 8001 directly; production authenticated access
must be provided by the gateway or an authenticated service boundary before using
these management endpoints outside the local machine.

## Step 1: local sitemap extraction

When the supplied sitemap XML is available locally, extract it without fetching
the live site:

```bash
PYTHONPATH=src python -m knowledge_brain.sitemap_extract path/to/sitemap.xml \
  --database data/manifest.sqlite3 \
  --report data/sitemap-extraction-report.json
```

This creates the `sitemap_imports`, `sitemap_source_urls`, and
`sitemap_rejected_urls` tables in SQLite using a transaction. Re-running the
command updates the existing URL records and preserves unrelated Knowledge Brain
tables. It records all accepted sitemap URLs, marks URLs matching
`/support/solutions/articles/` as articles, deduplicates normalized URLs, and
records rejected values. It does not download sitemap indexes or article pages.

To perform the explicit live Step 1 import, use the separate command below. It
fetches only the configured source sitemap and same-host child sitemap indexes;
it does not fetch article pages. The command fails without writing a successful
report when the source is unavailable, returns an HTTP error, exceeds the safety
limits, or contains invalid XML:

```bash
PYTHONPATH=src python -m knowledge_brain.sitemap_fetch \
  --source-url https://support.brilliantdirectories.com/support/sitemap.xml \
  --database data/manifest.sqlite3 \
  --report data/sitemap-extraction-report.json \
  --all-urls data/sitemap-urls.txt \
  --article-urls data/article-urls.txt
```

Child sitemap URLs must remain HTTPS and on the source hostname. Literal private,
loopback, metadata, credential-bearing, non-default-port, and unrelated-host URLs
are rejected before any child request. The persisted rows are in
`sitemap_imports`, `sitemap_source_urls`, and `sitemap_rejected_urls`; the two
text files contain the deduplicated URL sets used by the review UI.
