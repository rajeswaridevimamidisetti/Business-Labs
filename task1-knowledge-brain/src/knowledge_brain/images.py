"""Safe image reference collection and mockable description stage."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Callable, Protocol

from .article import ImageReference


@dataclass(frozen=True)
class ImageDownload:
    status_code: int
    content_type: str
    content: bytes


@dataclass(frozen=True)
class ImageDescription:
    image_url: str
    article_id: str
    context: str
    description: str | None
    uncertainty: str | None
    status: str
    content_hash: str | None = None


class ImageFetcher(Protocol):
    def __call__(self, url: str, timeout_seconds: float) -> ImageDownload: ...


class VisionDescriber(Protocol):
    def describe(self, image: bytes, image_url: str, context: str) -> str: ...


def process_images(
    article_id: str,
    references: tuple[ImageReference, ...],
    fetcher: ImageFetcher,
    describer: VisionDescriber | Callable[[bytes, str, str], str],
    *,
    timeout_seconds: float = 10.0,
    max_bytes: int = 5_000_000,
) -> tuple[ImageDescription, ...]:
    """Process relevant image references without inventing failed descriptions."""
    seen_urls: set[str] = set()
    seen_hashes: set[str] = set()
    results: list[ImageDescription] = []
    for reference in references:
        if reference.url in seen_urls:
            results.append(ImageDescription(reference.url, article_id, reference.context, None, "duplicate_url", "skipped"))
            continue
        seen_urls.add(reference.url)
        try:
            response = fetcher(reference.url, timeout_seconds)
            if not 200 <= response.status_code < 300:
                raise RuntimeError(f"HTTP {response.status_code}")
            if not response.content_type.lower().startswith("image/"):
                raise RuntimeError("unsupported_content_type")
            if len(response.content) > max_bytes:
                raise RuntimeError("image_too_large")
            digest = hashlib.sha256(response.content).hexdigest()
            if digest in seen_hashes:
                results.append(ImageDescription(reference.url, article_id, reference.context, None, "duplicate_content", "skipped", digest))
                continue
            seen_hashes.add(digest)
            describe = describer.describe if hasattr(describer, "describe") else describer
            description = describe(response.content, reference.url, reference.context)
            results.append(ImageDescription(reference.url, article_id, reference.context, description, None, "described", digest))
        except TimeoutError:
            results.append(ImageDescription(reference.url, article_id, reference.context, None, "download_timeout", "failed"))
        except Exception as exc:
            results.append(ImageDescription(reference.url, article_id, reference.context, None, str(exc)[:200], "failed"))
    return tuple(results)
