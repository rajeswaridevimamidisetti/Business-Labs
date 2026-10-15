"""Local-only Task 1 API server entry point."""

import os
from wsgiref.simple_server import make_server

from .api import QueryResult, SourceCitation, Task1Api, create_wsgi_app


class DemoQueryService:
    """Deterministic local evidence for HTTP smoke tests; not a model result."""

    def query(self, question: str, request_id: str) -> QueryResult:
        return QueryResult(
            answer="Demo mode found documented settings guidance.",
            status="answered",
            sources=(SourceCitation("Demo support article", "https://support.brilliantdirectories.com/support/demo", "Settings", "demo-chunk"),),
            human_help_needed=False,
            retrieval_trace=("demo-mode",),
        )


def main() -> None:
    demo_mode = os.getenv("TASK1_DEMO_MODE", "0").lower() in {"1", "true", "yes"}
    if not demo_mode and not os.getenv("CLAUDE_API_KEY"):
        raise SystemExit("CLAUDE_API_KEY is required outside TASK1_DEMO_MODE; no live model adapter is configured yet")
    api = Task1Api(query_service=DemoQueryService() if demo_mode else None)
    with make_server(os.getenv("TASK1_HOST", "127.0.0.1"), int(os.getenv("TASK1_PORT", "8001")), create_wsgi_app(api)) as server:
        print("Task 1 API listening on http://127.0.0.1:8001")
        server.serve_forever()


if __name__ == "__main__":
    main()
