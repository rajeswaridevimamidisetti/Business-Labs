"""HTML article extraction into inspectable, normalized records."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit


_IGNORED_TAGS = {"script", "style", "noscript", "template", "svg"}
_STRUCTURAL_BOILERPLATE = {"nav", "footer", "aside", "form"}
_BOILERPLATE_TOKENS = {
    "banner",
    "breadcrumb",
    "cookie",
    "feedback",
    "footer",
    "header-nav",
    "login",
    "menu",
    "navbar",
    "navigation",
    "pagination",
    "recommend",
    "related",
    "search",
    "sidebar",
    "social",
}
_DECORATIVE_IMAGE_TOKENS = {"avatar", "icon", "logo", "pixel", "spinner", "tracking"}


@dataclass(frozen=True)
class HeadingRecord:
    level: int
    text: str
    path: tuple[str, ...]


@dataclass(frozen=True)
class ListRecord:
    ordered: bool
    items: tuple[str, ...]


@dataclass(frozen=True)
class TableRecord:
    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


@dataclass(frozen=True)
class ImageReference:
    url: str
    position: int
    context: str
    alt_text: str | None
    source_attribute: str


@dataclass(frozen=True)
class NormalizedArticle:
    article_id: str
    canonical_url: str
    source_url: str
    title: str | None
    body_text: str
    headings: tuple[HeadingRecord, ...]
    lists: tuple[ListRecord, ...]
    tables: tuple[TableRecord, ...]
    procedural_steps: tuple[str, ...]
    images: tuple[ImageReference, ...]
    last_modified: str | None
    content_hash: str
    ingestion_timestamp: str
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def save_json(self, path: str | Path) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )


class _Node:
    def __init__(self, tag: str = "document", attrs: dict[str, str] | None = None) -> None:
        self.tag = tag.lower()
        self.attrs = attrs or {}
        self.children: list[_Node | str] = []
        self.parent: _Node | None = None

    def add(self, child: _Node | str) -> None:
        if isinstance(child, _Node):
            child.parent = self
        self.children.append(child)


class _DocumentParser(HTMLParser):
    _VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node()
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _Node(tag, {key.lower(): value or "" for key, value in attrs})
        self.stack[-1].add(node)
        if tag.lower() not in self._VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower() and tag.lower() not in self._VOID_TAGS:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if data:
            self.stack[-1].add(data)

    @property
    def unclosed_tags(self) -> tuple[str, ...]:
        return tuple(node.tag for node in self.stack[1:])


def parse_article(
    html: str | bytes,
    source_url: str,
    *,
    last_modified: str | None = None,
    ingestion_timestamp: str | None = None,
) -> NormalizedArticle:
    """Extract article content while preserving warnings about weak extraction."""

    raw = html.encode("utf-8") if isinstance(html, str) else html
    text = raw.decode("utf-8", "replace")
    parser = _DocumentParser()
    parser.feed(text)
    parser.close()
    canonical_url = _canonical_url(parser.root, source_url)
    article_id = f"article-{hashlib.sha256(canonical_url.encode()).hexdigest()[:16]}"
    warnings: list[str] = []
    if parser.unclosed_tags:
        warnings.append("malformed_html_recovered")

    content_root = _select_content_root(parser.root)
    if content_root is None:
        content_root = parser.root
        warnings.append("low_quality_extraction:no_content_container")

    title = _extract_title(parser.root, content_root)
    if not title:
        warnings.append("missing_title")
    body_text = _text(content_root)
    if not body_text:
        warnings.append("empty_body")

    headings = _extract_headings(content_root)
    lists = _extract_lists(content_root)
    tables = _extract_tables(content_root)
    images = _extract_images(content_root, canonical_url, headings)
    procedural_steps = tuple(
        item for record in lists if record.ordered for item in record.items
    )

    return NormalizedArticle(
        article_id=article_id,
        canonical_url=canonical_url,
        source_url=source_url,
        title=title,
        body_text=body_text,
        headings=tuple(headings),
        lists=tuple(lists),
        tables=tuple(tables),
        procedural_steps=procedural_steps,
        images=tuple(images),
        last_modified=last_modified or _extract_last_modified(parser.root),
        content_hash=hashlib.sha256(raw).hexdigest(),
        ingestion_timestamp=ingestion_timestamp or _now(),
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _canonical_url(root: _Node, source_url: str) -> str:
    for node in _walk(root):
        if node.tag == "link" and node.attrs.get("rel", "").lower() == "canonical":
            href = node.attrs.get("href", "").strip()
            if href:
                return _strip_fragment(urljoin(source_url, href))
    return _strip_fragment(source_url)


def _strip_fragment(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


def _extract_title(root: _Node, content_root: _Node) -> str | None:
    for node in _walk(content_root):
        if node.tag == "h1":
            value = _text(node)
            if value:
                return value
    for node in _walk(root):
        if node.tag == "meta" and node.attrs.get("property", "").lower() == "og:title":
            if node.attrs.get("content", "").strip():
                return _clean_text(node.attrs["content"])
    for node in _walk(root):
        if node.tag == "title":
            value = _text(node)
            if value:
                return value
    return None


def _extract_last_modified(root: _Node) -> str | None:
    keys = {"article:modified_time", "last-modified", "datemodified", "date_modified"}
    for node in _walk(root):
        if node.tag == "meta":
            key = (node.attrs.get("property") or node.attrs.get("name") or "").lower()
            value = node.attrs.get("content", "").strip()
            if key in keys and value:
                return value
    return None


def _select_content_root(root: _Node) -> _Node | None:
    candidates: list[tuple[int, int, _Node]] = []
    for order, node in enumerate(_walk(root)):
        if node.tag in _STRUCTURAL_BOILERPLATE or _is_boilerplate(node):
            continue
        identity = " ".join((node.attrs.get("id", ""), node.attrs.get("class", ""))).lower()
        score = 0
        if node.tag == "article":
            score += 100
        if node.tag == "main" or node.attrs.get("role", "").lower() == "main":
            score += 90
        if any(token in identity for token in ("article", "content", "solution", "answer", "body")):
            score += 60
        length = len(_text(node))
        if score and length:
            candidates.append((score, length - order, node))
    return max(candidates, key=lambda item: (item[0], item[1]))[2] if candidates else None


def _extract_headings(root: _Node) -> list[HeadingRecord]:
    path: list[str] = []
    result: list[HeadingRecord] = []
    for node in _walk(root):
        if node.tag not in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            continue
        value = _text(node)
        if not value:
            continue
        level = int(node.tag[1])
        path = path[: level - 1]
        path.append(value)
        result.append(HeadingRecord(level, value, tuple(path)))
    return result


def _extract_lists(root: _Node) -> list[ListRecord]:
    result: list[ListRecord] = []
    for node in _walk(root):
        if node.tag not in {"ul", "ol"} or _nearest_ancestor(node, {"ul", "ol"}) is not None:
            continue
        items = []
        for child in node.children:
            if isinstance(child, _Node) and child.tag == "li":
                value = _text(child)
                if value:
                    items.append(value)
        if items:
            result.append(ListRecord(node.tag == "ol", tuple(items)))
    return result


def _extract_tables(root: _Node) -> list[TableRecord]:
    result: list[TableRecord] = []
    for table in _walk(root):
        if table.tag != "table":
            continue
        rows: list[tuple[str, ...]] = []
        headers: tuple[str, ...] = ()
        for row in _walk(table):
            if row.tag != "tr":
                continue
            cells = tuple(_text(cell) for cell in row.children if isinstance(cell, _Node) and cell.tag in {"th", "td"})
            if not cells:
                continue
            if not headers and any(isinstance(cell, _Node) and cell.tag == "th" for cell in row.children):
                headers = cells
            else:
                rows.append(cells)
        if headers or rows:
            result.append(TableRecord(headers, tuple(rows)))
    return result


def _extract_images(root: _Node, canonical_url: str, headings: list[HeadingRecord]) -> list[ImageReference]:
    result: list[ImageReference] = []
    section = headings[-1].path[-1] if headings else ""
    for position, node in enumerate(_walk(root)):
        if node.tag != "img" or _is_decorative_image(node):
            continue
        raw_url, source_attribute = _image_source(node)
        if not raw_url:
            continue
        context = section
        if node.parent is not None:
            parent_text = _text(node.parent)
            if parent_text:
                context = _clean_text(f"{section}. {parent_text}".strip(". "))[:300]
        result.append(
            ImageReference(
                url=urljoin(canonical_url, raw_url),
                position=position,
                context=context,
                alt_text=_clean_text(node.attrs.get("alt", "")) or None,
                source_attribute=source_attribute,
            )
        )
    return result


def _image_source(node: _Node) -> tuple[str | None, str]:
    for attribute in ("src", "data-src", "data-lazy-src", "data-original"):
        if node.attrs.get(attribute, "").strip():
            return node.attrs[attribute].strip(), attribute
    srcset = node.attrs.get("srcset", "") or node.attrs.get("data-srcset", "")
    if srcset:
        first = srcset.split(",", 1)[0].strip().split(" ", 1)[0]
        return first or None, "srcset"
    return None, ""


def _is_decorative_image(node: _Node) -> bool:
    identity = " ".join((node.attrs.get("id", ""), node.attrs.get("class", ""))).lower()
    return any(token in identity for token in _DECORATIVE_IMAGE_TOKENS) and not node.attrs.get("alt", "").strip()


def _is_boilerplate(node: _Node) -> bool:
    identity = " ".join((node.attrs.get("id", ""), node.attrs.get("class", ""))).lower()
    tokens = set(re.findall(r"[a-z0-9_-]+", identity))
    return bool(tokens & _BOILERPLATE_TOKENS)


def _nearest_ancestor(node: _Node, tags: set[str]) -> _Node | None:
    current = node.parent
    while current is not None:
        if current.tag in tags:
            return current
        current = current.parent
    return None


def _walk(node: _Node) -> list[_Node]:
    result: list[_Node] = []
    for child in node.children:
        if not isinstance(child, _Node):
            continue
        if child.tag in _IGNORED_TAGS or child.tag in _STRUCTURAL_BOILERPLATE or _is_boilerplate(child):
            continue
        result.append(child)
        result.extend(_walk(child))
    return result


def _text(node: _Node) -> str:
    parts: list[str] = []
    for child in node.children:
        if isinstance(child, str):
            parts.append(child)
        elif child.tag not in _IGNORED_TAGS and child.tag not in _STRUCTURAL_BOILERPLATE and not _is_boilerplate(child):
            parts.append(_text(child))
    return _clean_text(" ".join(parts))


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
