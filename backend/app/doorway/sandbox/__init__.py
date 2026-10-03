"""Sandboxes: workers that claim jobs (discover, verify, heal, optimize, race) from the
shared queue in the store and cooperate through its message board and patterns.

Run: `uv run python -m app.doorway.sandbox --id sandbox-1` or `--count 4` (sandbox-1..4 as
concurrent workers in one process). Embed: `await run_workers(store, ["sandbox-1"], stop=ev)`.
"""

from .jobs import HANDLERS, JobContext, JobFailed
from .worker import Worker, run_workers

__all__ = ["HANDLERS", "JobContext", "JobFailed", "Worker", "run_workers"]
