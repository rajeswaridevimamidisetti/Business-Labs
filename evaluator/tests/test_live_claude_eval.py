import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from evaluator import live_claude_eval as runner


class FakeMessages:
    def __init__(self, response):
        self.response = response
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        return self.response


class LiveEvaluationTests(unittest.TestCase):
    def test_missing_key_fails_before_client_factory(self):
        with patch.dict(os.environ, {"CLAUDE_API_KEY": ""}, clear=False):
            with self.assertRaisesRegex(runner.EvaluationError, "missing"):
                runner.run_evaluation({}, lambda _: self.fail("client must not be created"), "model", {})

    def test_judgment_records_usage_and_provisional_score(self):
        response = SimpleNamespace(
            content=[SimpleNamespace(text='{"scores":{"answer_correctness":1},"overall_score":1,"rationale":"supported","human_review_required":false}')],
            usage=SimpleNamespace(input_tokens=12, output_tokens=8),
        )
        messages = FakeMessages(response)
        client = SimpleNamespace(messages=messages)
        case = runner.Case("task1-01", "task1", "question", "direct", {"required_citations": True})
        with patch.dict(os.environ, {"CLAUDE_API_KEY": "local-secret"}, clear=False), patch.object(
            runner, "fetch_application_output", return_value={"answer": "supported", "sources": [{"url": "x"}]}
        ), patch.object(runner, "RESULTS_DIR", Path(tempfile.mkdtemp())):
            destination = runner.run_evaluation({"task1": [case]}, lambda _: client, "model", {"task1": "x"})
        payload = json.loads(destination.read_text())
        result = payload["results"][0]
        self.assertEqual(result["status"], "executed")
        self.assertTrue(result["provider_called"])
        self.assertTrue(result["score"]["provisional"])
        self.assertEqual(result["token_usage"]["input_tokens"], 12)
        self.assertEqual(messages.calls, 1)

    def test_invalid_judgment_is_recorded_as_failure(self):
        response = SimpleNamespace(content=[SimpleNamespace(text="not json")], usage=SimpleNamespace(input_tokens=1, output_tokens=1))
        client = SimpleNamespace(messages=FakeMessages(response))
        case = runner.Case("task1-01", "task1", "question", "direct", {})
        with patch.dict(os.environ, {"CLAUDE_API_KEY": "local-secret"}, clear=False), patch.object(
            runner, "fetch_application_output", return_value={"answer": "x"}
        ), patch.object(runner, "RESULTS_DIR", Path(tempfile.mkdtemp())):
            destination = runner.run_evaluation({"task1": [case]}, lambda _: client, "model", {"task1": "x"})
        result = json.loads(destination.read_text())["results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["provider_called"] is False)
        self.assertIn("non-JSON", result["error"])


if __name__ == "__main__":
    unittest.main()
