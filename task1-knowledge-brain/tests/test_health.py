import unittest

from knowledge_brain.health import health


class HealthTest(unittest.TestCase):
    def test_foundation_health(self) -> None:
        self.assertEqual(
            health(), {"service": "task1-knowledge-brain", "status": "ok"}
        )


if __name__ == "__main__":
    unittest.main()
