"""Parsing and validation for the Knowledge Brain sitemap boundary."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
from collections.abc import Collection
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


def validate_sitemap_url(
    value: str,
    *,
    allowed_hosts: Collection[str] | None = None,
    allow_http: bool = True,
    allow_any_public_host: bool = True,
) -> str:
    """Validate and normalize a root sitemap URL before any network access."""
    normalized, reason = _normalized_url(
        value,
        allowed_hosts={"*"} if allow_any_public_host and allowed_hosts is None else allowed_hosts,
        allow_http=allow_http,
    )
    if normalized is None:
        raise ValueError(f"unsafe or invalid sitemap URL: {reason}")
    return normalized


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name:
            value = (child.text or "").strip()
            return value or None
    return None


def _normalized_url(
    value: str,
    *,
    allowed_hosts: Collection[str] | None = None,
    allow_http: bool = False,
) -> tuple[str | None, str | None]:
    candidate = value.strip()
    if not candidate:
        return None, "missing_url"

    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None, "invalid_url"

    scheme = parsed.scheme.lower()
    if scheme not in ({"https", "http"} if allow_http else {"https"}):
        return None, "unsupported_scheme"
    if parsed.username or parsed.password:
        return None, "credentials_not_allowed"
    if parsed.hostname is None:
        return None, "missing_host"
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in {"localhost", "metadata.google.internal", "metadata"}:
        return None, "private_host"
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        return None, "private_host"
    permitted_hosts = {host.lower().rstrip(".") for host in (allowed_hosts or (APPROVED_HOST,))}
    if "*" not in permitted_hosts and hostname not in permitted_hosts:
        return None, "host_not_approved"
    try:
        port = parsed.port
    except ValueError:
        return None, "invalid_port"
    if port is not None and port != 443:
        return None, "non_default_port"

    normalized = SplitResult(
        scheme=scheme,
        netloc=hostname,
        path=parsed.path or "/",
        query=parsed.query,
        fragment="",
    )
    return urlunsplit(normalized), None


def parse_sitemap(
    xml: str | bytes,
    *,
    allowed_hosts: Collection[str] | None = None,
    allow_http: bool = False,
    max_entries: int = 50_000,
) -> SitemapParseResult:
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

    if max_entries < 1:
        raise ValueError("max_entries must be positive")

    for index, item in enumerate(root):
        if index >= max_entries:
            skipped.append(SkippedUrl("", "entry_limit_exceeded"))
            break
        if _local_name(item.tag) != expected_item:
            continue
        raw_url = _child_text(item, "loc")
        normalized, reason = _normalized_url(
            raw_url or "", allowed_hosts=allowed_hosts, allow_http=allow_http
        )
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
