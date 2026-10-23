"""CLI for Step 1 local sitemap extraction."""

from __future__ import annotations

import argparse
import json
import os

from .sitemap import SITEMAP_URL
from .sitemap_import import extract_sitemap_file


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract URLs from a supplied local sitemap XML file")
    parser.add_argument("input", help="path to the supplied sitemap XML file")
    parser.add_argument("--source-url", default=SITEMAP_URL)
    parser.add_argument("--database", default=os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3"))
    parser.add_argument("--report", default="data/sitemap-extraction-report.json")
    parser.add_argument("--all-urls", default=None, help="output file for all unique sitemap URLs")
    parser.add_argument("--article-urls", default=None, help="output file for unique article URLs")
    args = parser.parse_args()
    report = extract_sitemap_file(
        args.input, source_url=args.source_url, database_path=args.database, report_path=args.report,
        all_urls_path=args.all_urls, article_urls_path=args.article_urls,
    )
    print(json.dumps(report.to_dict(), indent=2))


if __name__ == "__main__":
    main()
