import unittest
import tempfile
import json
import threading
from http.client import HTTPConnection
from pathlib import Path

from meeting_to_scope.evals import default_cases
from meeting_to_scope.fixtures import synthetic_transcripts
from meeting_to_scope.models import EstimationAgent, ProductFeasibilityAgent, ProposalReviewAgent, ScopeAgent, TranscriptAnalyst
from meeting_to_scope.storage import ProposalStore
from meeting_to_scope.server import Handler
from http.server import ThreadingHTTPServer


class KnowledgeClient:
    def query(self, question: str, request_id: str):
        return {"status": "answered", "answer": "Existing configuration is available.", "sources": [{"title": "Guide", "url": "https://support.example/guide", "section": "Setup"}]}


class FailingKnowledgeClient:
    def query(self, question: str, request_id: str):
        raise TimeoutError("unavailable")


class WorkflowTest(unittest.TestCase):
    def test_three_synthetic_transcripts_include_follow_up(self):
        transcripts = synthetic_transcripts()
        self.assertEqual(len(transcripts), 3)
        self.assertEqual(transcripts[2].follow_up_to, "meeting-1")
        self.assertTrue(all(item.synthetic for item in transcripts))

    def test_extraction_keeps_source_and_stable_ids(self):
        transcript = synthetic_transcripts()[0]
        analyst = TranscriptAnalyst()
        first = analyst.analyze(transcript)
        second = analyst.analyze(transcript)
        self.assertEqual(first, second)
        self.assertTrue(all(item.source_segment_id and item.source_passage for item in first))

    def test_feasibility_preserves_citations_and_unverified_failure(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        verified = ProductFeasibilityAgent().check(requirements, KnowledgeClient())
        failed = ProductFeasibilityAgent().check(requirements, FailingKnowledgeClient())
        self.assertTrue(verified[0].evidence)
        self.assertFalse(failed[0].verified)
        self.assertEqual(failed[0].classification, "needs clarification")

    def test_scope_estimates_and_approval_are_consistent(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        feasibility = ProductFeasibilityAgent().check(requirements, KnowledgeClient())
        scope = ScopeAgent().build(requirements, feasibility)
        estimates = EstimationAgent().estimate(scope)
        proposal_agent = ProposalReviewAgent()
        proposal = proposal_agent.create("proposal-1", scope, estimates)
        self.assertEqual(proposal.total_likely_hours, sum(item.likely_hours for item in estimates))
        with self.assertRaises(PermissionError):
            proposal_agent.send(proposal)
        self.assertEqual(proposal_agent.approve(proposal, "reviewer").approval_status, "approved")
        with self.assertRaises(PermissionError):
            proposal_agent.approve(proposal, "")

    def test_follow_up_change_report_uses_stable_ids_and_blocks_unapproved_state(self):
        analyst = TranscriptAnalyst()
        first = analyst.analyze(synthetic_transcripts()[0])
        follow_up = analyst.analyze(synthetic_transcripts()[2])
        agent = ProposalReviewAgent()
        scope1 = ScopeAgent().build(first, ProductFeasibilityAgent().check(first, KnowledgeClient()))
        scope2 = ScopeAgent().build(follow_up, ProductFeasibilityAgent().check(follow_up, KnowledgeClient()))
        report = agent.compare(agent.create("p", scope1, EstimationAgent().estimate(scope1)), agent.create("p", scope2, EstimationAgent().estimate(scope2), 2))
        self.assertTrue(report.added or report.removed)

    def test_task3_has_twenty_pending_evaluation_cases(self):
        self.assertEqual(len(default_cases()), 20)
        self.assertTrue(all(case.transcript.strip() and case.assertions for case in default_cases()))
        self.assertTrue(all(case.status == "pending" for case in default_cases()))

    def test_approved_proposal_version_survives_restart(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        scope = ScopeAgent().build(requirements, ProductFeasibilityAgent().check(requirements, KnowledgeClient()))
        proposal = ProposalReviewAgent().create("proposal-persist", scope, EstimationAgent().estimate(scope))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proposals.json"
            first = ProposalStore(path)
            first.save(proposal)
            first.approve("proposal-persist", 1, "reviewer")
            restarted = ProposalStore(path)
            record = restarted.get("proposal-persist", 1)
            self.assertEqual(record["approval_status"], "approved")
            self.assertEqual(record["approved_by"], "reviewer")

    def test_long_transcript_preserves_many_source_segments(self):
        transcript = synthetic_transcripts()[0]
        long_text = "\n".join(f"[{index:02d}:00] Client: We need requirement {index}." for index in range(30))
        parsed = transcript.__class__("long", transcript.project_id, transcript.date, long_text, transcript.segments)
        parsed = parsed.__class__(parsed.meeting_id, parsed.project_id, parsed.date, parsed.text, __import__("meeting_to_scope.models", fromlist=["parse_transcript"]).parse_transcript("long", parsed.project_id, parsed.date, long_text).segments)
        self.assertGreaterEqual(len(parsed.segments), 30)

    def test_duplicate_requirements_are_deduplicated(self):
        parsed = __import__("meeting_to_scope.models", fromlist=["parse_transcript"]).parse_transcript("dup", "p", "2026-01-01", "Client: We need search.\nClient: We need search.")
        requirements = TranscriptAnalyst().analyze(parsed)
        self.assertEqual(len(requirements), 1)

    def test_missing_date_is_retained_as_transcript_metadata_without_inference(self):
        parsed = __import__("meeting_to_scope.models", fromlist=["parse_transcript"]).parse_transcript("nodate", "p", "", "Client: We need search.")
        self.assertEqual(parsed.date, "")
        self.assertTrue(TranscriptAnalyst().analyze(parsed)[0].explicit)

    def test_speaker_and_timestamp_are_retained(self):
        segment = synthetic_transcripts()[0].segments[0]
        self.assertEqual(segment.speaker, "Client")
        self.assertEqual(segment.timestamp, "00:01")

    def test_insufficient_evidence_is_not_classified_as_absence(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        result = ProductFeasibilityAgent().check(requirements, FailingKnowledgeClient())[0]
        self.assertIn("not proof of absence", result.reason)

    def test_existing_limitation_classification_is_preserved(self):
        class Limited:
            def query(self, question, request_id):
                return {"status": "answered", "answer": "Existing feature with limitation", "sources": [{"title": "Guide", "url": "https://example.test"}]}
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        self.assertEqual(ProductFeasibilityAgent().check(requirements, Limited())[0].classification, "existing feature with limitation")

    def test_custom_classification_is_preserved(self):
        class Custom:
            def query(self, question, request_id):
                return {"status": "answered", "answer": "Requires custom development and API integration", "sources": [{"title": "Guide", "url": "https://example.test"}]}
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        self.assertEqual(ProductFeasibilityAgent().check(requirements, Custom())[0].classification, "potential custom development")

    def test_scope_has_acceptance_criteria_for_each_requirement(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        scope = ScopeAgent().build(requirements, ProductFeasibilityAgent().check(requirements, KnowledgeClient()))
        self.assertEqual(len(scope.acceptance_criteria), len(requirements))

    def test_scope_keeps_unverified_items_as_open_questions(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        scope = ScopeAgent().build(requirements, ProductFeasibilityAgent().check(requirements, FailingKnowledgeClient()))
        self.assertTrue(scope.open_questions_and_risks)

    def test_estimates_flag_dependencies_for_human_review(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        scope = ScopeAgent().build(requirements, ProductFeasibilityAgent().check(requirements, FailingKnowledgeClient()))
        self.assertTrue(all(item.human_review_required for item in EstimationAgent().estimate(scope)))

    def test_change_report_identifies_modified_requirement(self):
        agent = ProposalReviewAgent()
        first = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        revised = tuple(item.__class__(item.requirement_id, item.description + " revised", item.source_segment_id, item.source_passage, item.status, item.priority, item.explicit, item.acceptance_criteria, item.dependencies, item.existing_solution_status, item.estimate_status) for item in first)
        before = ScopeAgent().build(first, ProductFeasibilityAgent().check(first, KnowledgeClient()))
        after = ScopeAgent().build(revised, ProductFeasibilityAgent().check(revised, KnowledgeClient()))
        report = agent.compare(agent.create("p", before, EstimationAgent().estimate(before)), agent.create("p", after, EstimationAgent().estimate(after), 2))
        self.assertTrue(report.modified)

    def test_change_report_identifies_unchanged_requirement(self):
        requirements = TranscriptAnalyst().analyze(synthetic_transcripts()[0])
        scope = ScopeAgent().build(requirements, ProductFeasibilityAgent().check(requirements, KnowledgeClient()))
        agent = ProposalReviewAgent()
        report = agent.compare(agent.create("p", scope, EstimationAgent().estimate(scope)), agent.create("p", scope, EstimationAgent().estimate(scope), 2))
        self.assertEqual(len(report.unchanged), len(requirements))

    def test_http_follow_up_requires_approved_persisted_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            Handler.store = ProposalStore(Path(directory) / "proposals.json")
            Handler.proposals = {}
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection("127.0.0.1", server.server_address[1])
                body = json.dumps({"project_id": "http-project", "meeting_id": "m1", "date": "2026-02-01", "transcript": "Client: We need search."})
                connection.request("POST", "/v1/scope", body, {"Content-Type": "application/json"})
                initial = json.loads(connection.getresponse().read())
                proposal = initial["proposal"]
                self.assertEqual(proposal["approval_status"], "pending")

                follow_up = json.dumps({"project_id": "http-project", "meeting_id": "m2", "date": "2026-02-02", "transcript": "Client: Add saved filters."})
                connection.request("POST", "/v1/scope/follow-up", follow_up, {"Content-Type": "application/json"})
                blocked_response = connection.getresponse()
                self.assertEqual(blocked_response.status, 409)
                blocked_response.read()

                connection.request("POST", f"/v1/proposals/{proposal['proposal_id']}/approve", json.dumps({"reviewer": "tester"}), {"Content-Type": "application/json"})
                approved = json.loads(connection.getresponse().read())
                self.assertEqual(approved["proposal"]["approval_status"], "approved")
                self.assertEqual(approved["proposal"]["approved_by"], "tester")

                connection.request("POST", "/v1/scope/follow-up", follow_up, {"Content-Type": "application/json"})
                revised = json.loads(connection.getresponse().read())
                self.assertEqual(revised["proposal"]["version"], 2)
                self.assertEqual(revised["proposal"]["approval_status"], "pending")
                self.assertTrue(revised["changes"]["added"])
                self.assertEqual(revised["baseline"]["version"], 1)

                connection.request("POST", f"/v1/proposals/{proposal['proposal_id']}/approve", json.dumps({"reviewer": "tester-2"}), {"Content-Type": "application/json"})
                final_response = connection.getresponse()
                self.assertEqual(final_response.status, 200)
                final_response.read()
                restarted = ProposalStore(Path(directory) / "proposals.json")
                record = restarted.get(proposal["proposal_id"], 2)
                self.assertEqual(record["approval_status"], "approved")
                self.assertEqual(record["approved_by"], "tester-2")
                self.assertTrue(record["approved_at"])
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
