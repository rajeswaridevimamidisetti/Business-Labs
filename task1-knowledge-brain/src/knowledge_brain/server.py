"""Local-only Task 1 API server entry point."""

import os
from wsgiref.simple_server import make_server

from .api import Task1Api, create_wsgi_app


def main() -> None:
    from .indexed import IndexedQueryService

    query_service = IndexedQueryService(os.getenv("TASK1_MANIFEST_DB", "data/manifest.sqlite3"))
    api = Task1Api(query_service=query_service)
    with make_server(os.getenv("TASK1_HOST", "127.0.0.1"), int(os.getenv("TASK1_PORT", "8001")), create_wsgi_app(api)) as server:
        print("Task 1 API listening on http://127.0.0.1:8001")
        server.serve_forever()


if __name__ == "__main__":
    main()
