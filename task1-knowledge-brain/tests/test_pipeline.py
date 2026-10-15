import unittest

from knowledge_brain.api import QueryResult
from knowledge_brain.article import parse_article
from knowledge_brain.chunking import chunk_article
from knowledge_brain.images import ImageDownload, process_images
from knowledge_brain.rag import GroundedQueryService, ModelAnswer
from knowledge_brain.retrieval import RetrievalStore


class FakeModel:
    def answer(self, question, evidence, system_policy):
        return ModelAnswer("Grounded answer", (evidence[0].chunk.chunk_id,))


class PipelineTest(unittest.TestCase):
    def article(self):
        return parse_article(
            "<article><h1>Settings</h1><h2>Setup</h2><p>Open settings and save changes.</p><img src='/settings.png' alt='Settings'></article>",
            "https://support.brilliantdirectories.com/support/settings",
        )

    def test_images_are_mockable_and_failures_are_explicit(self):
        article = self.article()
        result = process_images(article.article_id, article.images, lambda url, timeout: ImageDownload(200, "image/png", b"png"), lambda image, url, context: "A settings button")
        self.assertEqual(result[0].status, "described")
        failed = process_images(article.article_id, article.images, lambda url, timeout: (_ for _ in ()).throw(TimeoutError()), lambda *args: "never")
        self.assertEqual(failed[0].uncertainty, "download_timeout")

    def test_chunk_ids_are_stable_and_retrieval_deactivates_old_sources(self):
        article = self.article()
        chunks = chunk_article(article, max_chars=200)
        self.assertEqual(chunks, chunk_article(article, max_chars=200))
        store = RetrievalStore()
        store.upsert(chunks)
        self.assertTrue(store.query("settings save", mode="keyword"))
        store.deactivate_article(article.article_id)
        self.assertEqual(store.query("settings save"), ())

    def test_rag_requires_supported_citations(self):
        article = self.article()
        store = RetrievalStore()
        store.upsert(chunk_article(article, max_chars=200))
        service = GroundedQueryService(store, FakeModel())
        result = service.query("How do I save settings?", "req-1")
        self.assertEqual(result.status, "answered")
        self.assertTrue(result.sources)
        self.assertNotIn("confidence", result.__dict__)

    def test_empty_retrieval_abstains(self):
        result = GroundedQueryService(RetrievalStore(), FakeModel()).query("unknown", "req-2")
        self.assertEqual(result.status, "insufficient_evidence")
        self.assertTrue(result.human_help_needed)


if __name__ == "__main__":
    unittest.main()
