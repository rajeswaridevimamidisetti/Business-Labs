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


class PartialModel:
    def answer(self, question, evidence, system_policy):
        return ModelAnswer("Settings are available.", (evidence[0].chunk.chunk_id,))


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

    def test_supported_website_settings_question_answers(self):
        article = self.article()
        store = RetrievalStore()
        store.upsert(chunk_article(article))
        result = GroundedQueryService(store, FakeModel()).query("How do I save settings?", "req-settings")
        self.assertEqual(result.status, "answered")

    def test_unrelated_personal_bank_balance_question_abstains(self):
        article = self.article()
        store = RetrievalStore()
        store.upsert(chunk_article(article))
        result = GroundedQueryService(store, FakeModel()).query(
            "What is the current balance in my personal bank account?", "req-bank"
        )
        self.assertEqual(result.status, "insufficient_evidence")
        self.assertIsNone(result.answer)
        self.assertIn(result.retrieval_trace[-1], {"no active evidence", "retrieved evidence does not sufficiently support the question"})

    def test_irrelevant_website_builder_documents_abstain(self):
        article = parse_article(
            "<article><h1>Website Builder</h1><p>Use the website builder to create static pages and SEO settings.</p></article>",
            "https://support.example/website-builder",
        )
        store = RetrievalStore()
        store.upsert(chunk_article(article))
        result = GroundedQueryService(store, FakeModel()).query(
            "How do I configure payment gateway settings?", "req-irrelevant"
        )
        self.assertEqual(result.status, "insufficient_evidence")
        self.assertIsNone(result.answer)

    def test_relevant_but_incomplete_evidence_abstains(self):
        article = parse_article(
            "<article><h1>Settings</h1><p>Settings can be updated by an administrator.</p></article>",
            "https://support.example/settings",
        )
        store = RetrievalStore()
        store.upsert(chunk_article(article))
        result = GroundedQueryService(store, PartialModel()).query(
            "How do I configure settings and save changes?", "req-incomplete"
        )
        self.assertEqual(result.status, "insufficient_evidence")
        self.assertIsNone(result.answer)

    def test_billing_settings_prefers_topic_specific_document_over_navigation(self):
        navigation = parse_article(
            "<article><h1>Knowledge base</h1><p>Dashboard settings and billing links are listed here.</p></article>",
            "https://support.example/knowledge-base",
        )
        billing = parse_article(
            "<article><h1>Payment Settings</h1><p>Open Finance, then Payment Settings to update billing settings for the directory.</p></article>",
            "https://support.example/payment-settings",
        )
        store = RetrievalStore()
        store.upsert(chunk_article(navigation) + chunk_article(billing))
        result = GroundedQueryService(store, FakeModel()).query(
            "How can I update the billing settings for my directory?", "req-billing"
        )
        self.assertEqual(result.status, "answered")
        self.assertEqual(result.sources[0].url, "https://support.example/payment-settings")

    def test_signup_form_prefers_form_manager_document(self):
        navigation = parse_article(
            "<article><h1>Knowledge base</h1><p>Member links and site navigation are listed here.</p></article>",
            "https://support.example/knowledge-base",
        )
        form_manager = parse_article(
            "<article><h1>Form Manager</h1><p>Open Toolbox, then Form Manager to change the member signup form fields.</p></article>",
            "https://support.example/form-manager",
        )
        store = RetrievalStore()
        store.upsert(chunk_article(navigation) + chunk_article(form_manager))
        result = GroundedQueryService(store, FakeModel()).query(
            "Where can I change the member signup form shown on our site?", "req-signup"
        )
        self.assertEqual(result.status, "answered")
        self.assertEqual(result.sources[0].url, "https://support.example/form-manager")


if __name__ == "__main__":
    unittest.main()
