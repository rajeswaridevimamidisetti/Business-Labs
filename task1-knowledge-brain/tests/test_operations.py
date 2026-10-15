import tempfile
import unittest
from pathlib import Path

from knowledge_brain.api import Escalation, SourceCitation
from knowledge_brain.crawl import CrawlResult, PageOutcome
from knowledge_brain.evals import default_cases, EvaluationResult, write_results
from knowledge_brain.escalation import VersionedEscalationStore
from knowledge_brain.operations import DailyIngestionJob


class FakeRunner:
    def run(self):
        return CrawlResult(2, 2, (PageOutcome("a", "new", 1), PageOutcome("b", "failed", 1, "down")), 1, True)


class OperationsTest(unittest.TestCase):
    def test_escalation_answers_are_authorized_versioned_and_expirable(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VersionedEscalationStore(Path(directory) / "escalations.db", {"expert"})
            record = store.create("Question", "missing evidence", (), "req")
            with self.assertRaises(PermissionError):
                store.approve_expert_answer(record.escalation_id, "bad", (), "general", "other")
            answer = store.approve_expert_answer(record.escalation_id, "Reviewed", (), "general", "expert", "2099-01-01T00:00:00+00:00")
            self.assertEqual(answer.version, 1)
            self.assertEqual(len(store.retrievable_answers("general", "2026-01-01T00:00:00+00:00")), 1)
            self.assertEqual(len(store.retrievable_answers("other")), 0)
            store.close()

    def test_daily_job_reports_counts_and_prevents_existing_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "run.lock"
            lock.write_text("active")
            blocked = DailyIngestionJob(lambda: FakeRunner(), lock)
            self.assertEqual(blocked.run().state, "already_running")
            lock.unlink()
            report = blocked.run()
            self.assertEqual((report.added, report.failed, report.removed), (1, 1, 1))

    def test_evaluation_suite_has_twenty_pending_cases_and_writes_raw_files(self):
        self.assertEqual(len(default_cases()), 20)
        with tempfile.TemporaryDirectory() as directory:
            write_results((EvaluationResult("task1-01", "config-a"),), directory)
            self.assertTrue((Path(directory) / "task1-results.json").exists())
            self.assertTrue((Path(directory) / "task1-results.csv").exists())


if __name__ == "__main__":
    unittest.main()
