"""Parsing and validation for the Knowledge Brain sitemap boundary."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit
import xml.etree.ElementTree as ET


APPROVED_HOST = "support.brilliantdirectories.com"
SITEMAP_URL = "https://support.brilliantdirectories.com/support/sitemap.xml"


@dataclass(frozen=True)
class SitemapEntry:
    url: str
    last_modified: str | None = None


@dataclass(frozen=True)
class SkippedUrl:
    value: str
    reason: str


@dataclass(frozen=True)
class SitemapParseResult:
    kind: str
    entries: tuple[SitemapEntry, ...]
    child_sitemaps: tuple[SitemapEntry, ...]
    skipped: tuple[SkippedUrl, ...]


class SitemapParseError(ValueError):
    """Raised when a sitemap is not well-formed XML or has an unknown root."""


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name:
            value = (child.text or "").strip()
            return value or None
    return None


def _normalized_url(value: str) -> tuple[str | None, str | None]:
    candidate = value.strip()
    if not candidate:
        return None, "missing_url"

    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None, "invalid_url"

    if parsed.scheme.lower() != "https":
        return None, "unsupported_scheme"
    if parsed.username or parsed.password:
        return None, "credentials_not_allowed"
    if parsed.hostname is None:
        return None, "missing_host"
    if parsed.hostname.lower() != APPROVED_HOST:
        return None, "host_not_approved"
    try:
        port = parsed.port
    except ValueError:
        return None, "invalid_port"
    if port is not None and port != 443:
        return None, "non_default_port"

    normalized = SplitResult(
        scheme="https",
        netloc=APPROVED_HOST,
        path=parsed.path or "/",
        query=parsed.query,
        fragment="",
    )
    return urlunsplit(normalized), None


def parse_sitemap(xml: str | bytes) -> SitemapParseResult:
    """Parse one sitemap document without fetching child sitemaps.

    URL entries are normalized, deduplicated, and rejected with an explicit
    reason. A sitemap index returns child sitemap URLs in ``child_sitemaps``;
    callers decide whether and when to fetch those documents.
    """

    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise SitemapParseError("malformed sitemap XML") from exc

    root_name = _local_name(root.tag)
    if root_name not in {"urlset", "sitemapindex"}:
        raise SitemapParseError(f"unsupported sitemap root: {root_name}")

    seen: set[str] = set()
    entries: list[SitemapEntry] = []
    child_sitemaps: list[SitemapEntry] = []
    skipped: list[SkippedUrl] = []
    expected_item = "url" if root_name == "urlset" else "sitemap"

    for item in root:
        if _local_name(item.tag) != expected_item:
            continue
        raw_url = _child_text(item, "loc")
        normalized, reason = _normalized_url(raw_url or "")
        if normalized is None:
            skipped.append(SkippedUrl(raw_url or "", reason or "invalid_url"))
            continue
        if normalized in seen:
            skipped.append(SkippedUrl(normalized, "duplicate_url"))
            continue
        seen.add(normalized)
        entry = SitemapEntry(normalized, _child_text(item, "lastmod"))
        if root_name == "urlset":
            entries.append(entry)
        else:
            child_sitemaps.append(entry)

    return SitemapParseResult(
        kind=root_name,
        entries=tuple(entries),
        child_sitemaps=tuple(child_sitemaps),
        skipped=tuple(skipped),
    )
