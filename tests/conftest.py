"""OLVR test configuration.

The legacy GhostLink suites (test_app.py, test_api_keys.py) need the FastAPI
stack, which is not a dependency of the OLVR modules. They are skipped when
those packages are absent so that a bare `pytest` run stays green instead of
failing during collection.
"""
import importlib.util

collect_ignore = []

for _mod, _file in (("fastapi", "test_app.py"), ("fastapi", "test_api_keys.py")):
    if importlib.util.find_spec(_mod) is None:
        collect_ignore.append(_file)
