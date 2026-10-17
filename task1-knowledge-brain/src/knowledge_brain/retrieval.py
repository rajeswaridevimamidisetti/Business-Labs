"""Replaceable retrieval interfaces with a deterministic local implementation."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Protocol

from .chunking import DocumentChunk


class EmbeddingProvider(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class RetrievedChunk:
    chunk: DocumentChunk
    score: float
    mode: str


class RetrievalStore:
    def __init__(self, embedding_provider: EmbeddingProvider | None = None) -> None:
        self.embedding_provider = embedding_provider
        self._chunks: dict[str, DocumentChunk] = {}
        self._vectors: dict[str, list[float]] = {}

    def upsert(self, chunks: tuple[DocumentChunk, ...] | list[DocumentChunk]) -> None:
        chunks = list(chunks)
        for chunk in chunks:
            self._chunks[chunk.chunk_id] = chunk
        if self.embedding_provider and chunks:
            vectors = self.embedding_provider.embed([chunk.content for chunk in chunks])
            if len(vectors) != len(chunks):
                raise ValueError("embedding count does not match chunk count")
            for chunk, vector in zip(chunks, vectors):
                self._vectors[chunk.chunk_id] = vector

    def deactivate_article(self, article_id: str) -> None:
        for chunk_id, chunk in list(self._chunks.items()):
            if chunk.article_id == article_id:
                self._chunks[chunk_id] = DocumentChunk(**{**chunk.__dict__, "active": False})

    def query(self, text: str, *, k: int = 5, mode: str = "keyword") -> tuple[RetrievedChunk, ...]:
        if mode not in {"keyword", "semantic", "hybrid"}:
            raise ValueError("unsupported retrieval mode")
        tokens = _tokens(text)
        results: list[RetrievedChunk] = []
        for chunk in self._chunks.values():
            if not chunk.active:
                continue
            content_tokens = _tokens(chunk.content)
            metadata_tokens = _tokens(" ".join((chunk.title or "", *chunk.section_path)))
            content_overlap = len(tokens & content_tokens)
            metadata_overlap = len(tokens & metadata_tokens)
            keyword_score = (content_overlap + (2 * metadata_overlap)) / max(len(tokens), 1)
            score = keyword_score
            if mode in {"semantic", "hybrid"} and self.embedding_provider is not None:
                query_vector = self.embedding_provider.embed([text])[0]
                vector = self._vectors.get(chunk.chunk_id, [])
                semantic_score = _cosine(query_vector, vector)
                score = semantic_score if mode == "semantic" else (keyword_score + semantic_score) / 2
            if score > 0:
                results.append(RetrievedChunk(chunk, score, mode))
        results.sort(key=lambda result: result.score, reverse=True)
        return tuple(results[:k])


_STOP_WORDS = {
    "a", "an", "and", "are", "can", "do", "does", "for", "from", "how",
    "i", "in", "is", "it", "my", "of", "on", "please", "the", "to", "what",
    "where", "which", "with", "work", "you",
}

_TERM_ALIASES = {
    "signup": "signup",
    "signups": "signup",
    "registration": "signup",
    "registrations": "signup",
    "register": "signup",
    "payment": "billing",
    "payments": "billing",
    "finance": "billing",
    "billing": "billing",
    "configuration": "settings",
    "configurations": "settings",
    "preferences": "settings",
    "forms": "form",
    "members": "member",
}


def _tokens(text: str) -> set[str]:
    return {
        _TERM_ALIASES.get(token, token)
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 2 and token not in _STOP_WORDS
    }


def evidence_supports_question(question: str, evidence: tuple[RetrievedChunk, ...]) -> bool:
    """Require topical overlap, not merely a citation-shaped retrieval result."""

    query_terms = _tokens(question)
    if not query_terms or not evidence:
        return False
    best_overlap = max(
        len(query_terms & _tokens(f"{item.chunk.title or ''} {' '.join(item.chunk.section_path)} {item.chunk.content}"))
        for item in evidence
    )
    if len(query_terms) <= 2:
        return best_overlap == len(query_terms)
    return best_overlap >= 2 and best_overlap / len(query_terms) >= 0.4


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = sum(a * a for a in left) ** 0.5
    right_norm = sum(b * b for b in right) ** 0.5
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0
