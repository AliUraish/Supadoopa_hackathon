"""uv run python -m app.doorway.sandbox [--id sandbox-1] [--count 4] [--kinds discover,verify]

Uses the shared store (SupabaseStore: SUPABASE_URL + SUPABASE_SECRET_KEY). Stops cleanly on
SIGINT/SIGTERM (offline heartbeat + sandbox.offline event).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import signal
import sys

from ..browser import close_browser
from ..store import get_doorway_store
from . import liveview
from .worker import ALL_KINDS, run_workers


def sandbox_ids(first: str, count: int) -> list[str]:
    """--id sandbox-1 --count 3 -> sandbox-1, sandbox-2, sandbox-3."""
    if count <= 1:
        return [first]
    m = re.fullmatch(r"(.*?)-?(\d+)", first)
    prefix, start = (m[1], int(m[2])) if m else (first, 1)
    return [f"{prefix}-{start + i}" for i in range(count)]


async def main(ids: list[str], kinds: list[str] | None, poll: float) -> None:
    store = get_doorway_store()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    tasks = [run_workers(store, ids, kinds=kinds, stop=stop, poll=poll)]
    if port := os.environ.get("PORT"):  # Supabase Compute: public live view of the browsers
        tasks.append(liveview.serve(ids, int(port), stop, store))
    try:
        await asyncio.gather(*tasks)
    finally:
        await close_browser()


def cli(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.doorway.sandbox", description=__doc__)
    parser.add_argument("--id", default="sandbox-1", help="sandbox id (first id with --count)")
    parser.add_argument("--count", type=int, default=1, help="workers to run in this process")
    parser.add_argument("--kinds", default="", help=f"comma list of {','.join(ALL_KINDS)}")
    parser.add_argument("--poll", type=float, default=1.0, help="seconds between empty polls")
    args = parser.parse_args(argv)
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()] or None
    if kinds and (unknown := set(kinds) - set(ALL_KINDS)):
        parser.error(f"unknown job kinds: {', '.join(sorted(unknown))}")
    logging.basicConfig(
        level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(message)s"
    )
    asyncio.run(main(sandbox_ids(args.id, args.count), kinds, args.poll))


if __name__ == "__main__":
    cli()
