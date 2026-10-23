"""Fetch and persist the approved live sitemap without fetching article pages."""

from __future__ import annotations

import argparse
import json
import os
import sys

from .sitemap import SITEMAP_URL
from .sitemap_import import SitemapFetchError, fetch_sitemap_collection, persist_fetched_sitemap


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch a trusted sitemap/index and persist its URLs locally"
    )
    parser.add_argument("--source-url", default=os.getenv("TASK1_SITEMAP_URL", SITEMAP_URL))
    parser.add_argument("--database", default=os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3"))
    parser.add_argument("--report", default="data/sitemap-extraction-report.json")
    parser.add_argument("--all-urls", default=None, help="output file for all unique sitemap URLs")
    parser.add_argument("--article-urls", default=None, help="output file for unique article URLs")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--max-documents", type=int, default=100)
    parser.add_argument("--max-bytes", type=int, default=20 * 1024 * 1024)
    args = parser.parse_args()
    try:
        collection = fetch_sitemap_collection(
            args.source_url,
            timeout_seconds=args.timeout,
            max_documents=args.max_documents,
            max_bytes_per_document=args.max_bytes,
        )
        report = persist_fetched_sitemap(
            collection,
            database_path=args.database,
            report_path=args.report,
            all_urls_path=args.all_urls,
            article_urls_path=args.article_urls,
        )
    except (SitemapFetchError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1
    payload = {**report.to_dict(), "documents_fetched": collection.documents_fetched, "ok": True}
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
