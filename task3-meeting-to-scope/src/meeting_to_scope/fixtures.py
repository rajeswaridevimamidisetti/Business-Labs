from pathlib import Path

from .models import Transcript, parse_transcript


FIXTURES = Path(__file__).parent.parent.parent / "tests" / "fixtures"


def synthetic_transcripts() -> tuple[Transcript, ...]:
    return (
        parse_transcript("meeting-1", "website-refresh", "2026-01-10", "[00:01] Client: We need search and filters.\n[00:03] Client: Mobile users must have a usable experience.\n[00:05] Consultant: We should confirm the existing search configuration."),
        parse_transcript("meeting-2", "commerce-workflow", "2026-01-12", "[00:01] Client: We need checkout and order notifications.\n[00:04] Client: Payment integration must be reviewed for provider support."),
        parse_transcript("meeting-3", "website-refresh", "2026-01-17", "[00:01] Client: Add saved filters.\n[00:03] Client: Remove the advanced export feature.\n[00:05] Client: Delivery should move to March 30.", follow_up_to="meeting-1"),
    )
