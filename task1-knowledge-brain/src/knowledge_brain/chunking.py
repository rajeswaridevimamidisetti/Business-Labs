"""Configurable article-to-chunk transformation."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re

from .article import NormalizedArticle


@dataclass(frozen=True)
class DocumentChunk:
    chunk_id: str
    article_id: str
    title: str | None
    url: str
    section_path: tuple[str, ...]
    content: str
    content_hash: str
    source_type: str
    image_references: tuple[str, ...]
    ingestion_version: str
    active: bool = True


def chunk_article(
    article: NormalizedArticle,
    *,
    max_chars: int = 1200,
    overlap_chars: int = 100,
    ingestion_version: str = "v1",
) -> tuple[DocumentChunk, ...]:
    if max_chars < 100 or overlap_chars < 0 or overlap_chars >= max_chars:
        raise ValueError("invalid chunk size or overlap")
    sections = _sections(article)
    chunks: list[DocumentChunk] = []
    for section_path, text in sections:
        start = 0
        while start < len(text):
            end = min(len(text), start + max_chars)
            content = text[start:end].strip()
            if content:
                digest = hashlib.sha256(content.encode()).hexdigest()
                chunk_id = f"{article.article_id}:{article.content_hash[:12]}:{digest[:12]}"
                chunks.append(DocumentChunk(chunk_id, article.article_id, article.title, article.canonical_url, section_path, content, digest, "article_text", tuple(image.url for image in article.images), ingestion_version))
            if end == len(text):
                break
            start = end - overlap_chars
    return tuple(chunks)


def _sections(article: NormalizedArticle) -> list[tuple[tuple[str, ...], str]]:
    heading = article.headings[-1].path if article.headings else ()
    pieces = [article.body_text]
    for record in article.lists:
        pieces.append("\n".join(record.items))
    for table in article.tables:
        pieces.append("\n".join((" | ".join(table.headers), *(" | ".join(row) for row in table.rows))))
    text = re.sub(r"\s+", " ", "\n".join(piece for piece in pieces if piece)).strip()
    return [(heading, text)] if text else []
