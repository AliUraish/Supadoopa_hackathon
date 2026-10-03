"""Run the demo sites.

uv run python -m demo_sites --site bella-bistro --port 4101
uv run python -m demo_sites --all          # 4101-4103 at once
"""

from __future__ import annotations

import argparse

from demo_sites import SITES, create_app
from demo_sites.common import admin_token, start_server

CLINIC = (
    "PORT=4100 CLINIC_ADMIN_TOKEN=${DEMO_ADMIN_TOKEN} node supabase/compute/clinic/dev.mjs"
    "   # from the repo root"
)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m demo_sites", description=__doc__.strip())
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--site", choices=SITES, help="run one site")
    which.add_argument("--all", action="store_true", help="run every site on its default port")
    parser.add_argument("--port", type=int, help="port for --site (default: the site's own)")
    parser.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 inside a container")
    args = parser.parse_args(argv)
    if args.all and args.port:
        parser.error("--port only works with --site")

    targets = list(SITES) if args.all else [args.site]
    running = []
    try:
        for site_id in targets:
            port = args.port or SITES[site_id][1]
            running.append(start_server(create_app(site_id), args.host, port, log_level="info"))
            print(f"{site_id:<13} {running[-1].url}", flush=True)
        if not admin_token():
            print("warning: DEMO_ADMIN_TOKEN is not set, so /admin/* rejects every request")
        if args.all:
            print(f"sunrise-clinic (Node): {CLINIC}", flush=True)
        while all(r.thread.is_alive() for r in running):
            running[0].thread.join(0.5)
    except KeyboardInterrupt:
        pass
    except RuntimeError as e:  # most likely the port is taken
        parser.exit(1, f"error: {e}\n")
    finally:
        for r in running:
            r.stop()


if __name__ == "__main__":
    main()
