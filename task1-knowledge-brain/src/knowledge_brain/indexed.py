"""Load crawled article versions into the existing retrieval pipeline."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .api import QueryResult, SourceCitation
from .article import parse_article
from .chunking import chunk_article
from .rag import ModelAnswer
from .retrieval import RetrievalStore


class ExtractiveAnswerModel:
    """Return retrieved source text without inventing a model-generated answer."""

    def answer(self, question: str, evidence, system_policy: str) -> ModelAnswer:
        first = evidence[0]
        return ModelAnswer(first.chunk.content, tuple(item.chunk.chunk_id for item in evidence[:1]))


def load_index(database_path: str | Path) -> RetrievalStore:
    """Build an in-memory retrieval index from active crawler content."""

    if not Path(database_path).exists():
        raise RuntimeError(f"retrieval index is unavailable: database does not exist at {database_path}")
    store = RetrievalStore()
    connection = sqlite3.connect(str(database_path))
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT s.url, v.content
            FROM sources AS s
            JOIN article_versions AS v
              ON v.url = s.url AND v.content_hash = s.content_hash
            WHERE s.active = 1 AND s.status IN ('new', 'changed', 'unchanged')
            ORDER BY s.url
            """
        ).fetchall()
    except sqlite3.Error as exc:
        raise RuntimeError(f"retrieval index is unavailable: {exc}") from exc
    finally:
        connection.close()

    chunks = []
    for row in rows:
        article = parse_article(row["content"], row["url"])
        chunks.extend(chunk_article(article))
    store.upsert(chunks)
    return store


class IndexedQueryService:
    """Query only documents persisted by the crawler; empty indexes abstain."""

    def __init__(self, database_path: str | Path, *, top_k: int = 5) -> None:
        self.store = load_index(database_path)
        self.top_k = top_k

    def query(self, question: str, request_id: str) -> QueryResult:
        evidence = self.store.query(question, k=self.top_k, mode="keyword")
        if not evidence:
            return QueryResult(
                None,
                "insufficient_evidence",
                human_help_needed=True,
                retrieval_trace=("no matching active indexed documents",),
            )
        generated = ExtractiveAnswerModel().answer(question, evidence, "")
        citations = tuple(
            SourceCitation(
                item.chunk.title or "Untitled",
                item.chunk.url,
                "/".join(item.chunk.section_path) or None,
                item.chunk.chunk_id,
            )
            for item in evidence[:1]
        )
        return QueryResult(
            generated.answer,
            "answered",
            citations,
            tuple(evidence[0].chunk.image_references),
            False,
            tuple(item.chunk.chunk_id for item in evidence),
        )
