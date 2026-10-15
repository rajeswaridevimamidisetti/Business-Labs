"""Command-line ingestion entry point for the SQLite-backed retrieval index."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .crawl import CrawlConfig, CrawlRunner, ManifestStore
from .sitemap import SITEMAP_URL


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl support articles into the Task 1 manifest database")
    parser.add_argument("--database", default=os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3"))
    parser.add_argument("--sitemap", default=SITEMAP_URL)
    parser.add_argument("--max-articles", type=int, default=int(os.getenv("TASK1_MAX_ARTICLES", "10")))
    args = parser.parse_args()
    manifest = ManifestStore(Path(args.database))
    try:
        result = CrawlRunner(manifest, config=CrawlConfig(max_articles=args.max_articles)).run(args.sitemap)
    finally:
        manifest.close()
    print(
        f"indexed crawl complete: discovered={result.discovered_count} "
        f"selected={result.selected_count} failed={sum(item.status == 'failed' for item in result.outcomes)}"
    )


if __name__ == "__main__":
    main()
