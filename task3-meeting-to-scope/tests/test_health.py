import unittest

from meeting_to_scope.health import health


class HealthTest(unittest.TestCase):
    def test_foundation_health(self) -> None:
        self.assertEqual(
            health(), {"service": "task3-meeting-to-scope", "status": "ok"}
        )


if __name__ == "__main__":
    unittest.main()
