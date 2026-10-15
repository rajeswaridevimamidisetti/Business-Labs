# Task 1 Knowledge Brain

Local setup:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
PYTHONPATH=src python -m unittest discover -s tests
```

Run the local-only API:

```bash
PYTHONPATH=src python -m knowledge_brain.server
```

The API contract is documented in `docs/task1-api.md` and `docs/task1-openapi.json`. The server has no authentication and must remain bound to loopback.