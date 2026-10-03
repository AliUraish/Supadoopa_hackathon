"""Run the whole Doorway backend locally: database, API on :8000 and N sandbox workers.

    uv run python scripts/dev_stack.py                 # local Postgres + PostgREST
    uv run python scripts/dev_stack.py --sandboxes 4 --seed http://localhost:4100/
    uv run python scripts/dev_stack.py --db remote     # real Supabase (migrations applied)

The local database lives in backend/.devdb and survives restarts (delete it to reset).
Stripe stays in test mode; STRIPE_PROFILE_ID falls back to a local placeholder so paid tools
work end to end with sandbox test tokens.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

BACKEND = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(BACKEND), str(BACKEND / "tests")]

from conftest import JWT_SECRET, MIGRATIONS, STUB_SQL, make_jwt  # noqa: E402

DEVDB = BACKEND / ".devdb"
PG_PORT, REST_PORT = 54329, 54330


def wait_http(url: str, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            httpx.get(url, timeout=1)
            return
        except httpx.HTTPError:
            time.sleep(0.2)
    raise SystemExit(f"{url} did not come up")


def local_db(procs: list[subprocess.Popen]) -> dict[str, str]:
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    fresh = not (DEVDB / "PG_VERSION").exists()
    if fresh:
        subprocess.run(
            ["initdb", "-D", str(DEVDB), "-U", "postgres", "--auth=trust"], check=True, **quiet
        )
    subprocess.run(
        [
            "pg_ctl",
            "-D",
            str(DEVDB),
            "-w",
            "-l",
            str(DEVDB / "pg.log"),
            "start",
            "-o",
            f"-p {PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''",
        ],
        check=True,
        **quiet,
    )
    psql = [
        "psql",
        "-h",
        "127.0.0.1",
        "-p",
        str(PG_PORT),
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
    ]
    if fresh:
        for sql in (STUB_SQL, *MIGRATIONS):
            subprocess.run([*psql, "-f", str(sql)], check=True, **quiet)
        # Dashboard users come from the real Supabase Auth, which this local DB doesn't have.
        subprocess.run(
            [
                *psql,
                "-c",
                "alter table doorway_profiles drop constraint doorway_profiles_user_id_fkey;"
                "alter table doorway_consents drop constraint doorway_consents_user_id_fkey;"
                "alter table billing_customers drop constraint billing_customers_user_id_fkey;",
            ],
            check=True,
            **quiet,
        )
    env = {
        **os.environ,
        "PGRST_DB_URI": f"postgres://authenticator@127.0.0.1:{PG_PORT}/postgres",
        "PGRST_DB_SCHEMAS": "public",
        "PGRST_DB_ANON_ROLE": "anon",
        "PGRST_JWT_SECRET": JWT_SECRET,
        "PGRST_SERVER_HOST": "127.0.0.1",
        "PGRST_SERVER_PORT": str(REST_PORT),
    }
    procs.append(subprocess.Popen(["postgrest"], env=env, **quiet))
    wait_http(f"http://127.0.0.1:{REST_PORT}")
    state = "created" if fresh else "reused"
    print(f"db: local Postgres :{PG_PORT}, PostgREST :{REST_PORT} ({state})")
    return {
        "SUPABASE_REST_URL": f"http://127.0.0.1:{REST_PORT}",
        "SUPABASE_SECRET_KEY": make_jwt({"role": "service_role", "exp": 4102444800}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--db", choices=["local", "remote"], default="local")
    parser.add_argument("--sandboxes", type=int, default=4)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--seed", nargs="*", default=[], help="site URLs to add and discover")
    args = parser.parse_args()

    procs: list[subprocess.Popen] = []
    env = {
        **os.environ,
        "MPP_REALM": os.environ.get("MPP_REALM", "doorway"),
        "STRIPE_PROFILE_ID": os.environ.get("STRIPE_PROFILE_ID") or "profile_test_local",
        "API_URL": f"http://localhost:{args.port}",
        # Local demo: dashboard works without Supabase anonymous sign-ins.
        "DOORWAY_DEMO_OPEN": os.environ.get("DOORWAY_DEMO_OPEN", "1"),
        "DEMO_ADMIN_TOKEN": os.environ.get("DEMO_ADMIN_TOKEN", "devtoken"),
    }
    try:
        if args.db == "local":
            env.update(local_db(procs))
        api = subprocess.Popen(
            ["uv", "run", "uvicorn", "app.main:app", "--port", str(args.port)], cwd=BACKEND, env=env
        )
        procs.append(api)
        wait_http(f"http://127.0.0.1:{args.port}/health")
        if args.sandboxes:
            procs.append(
                subprocess.Popen(
                    [
                        "uv",
                        "run",
                        "python",
                        "-m",
                        "app.doorway.sandbox",
                        "--count",
                        str(args.sandboxes),
                    ],
                    cwd=BACKEND,
                    env=env,
                )
            )
        print(f"api: http://localhost:{args.port}  (docs /docs, MCP /doorway/mcp)")
        print(f"sandboxes: {args.sandboxes}")
        for url in args.seed:
            # Dashboard endpoints need a user; for local seeding call the store directly.
            seed = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    "-c",
                    "import asyncio,sys; from app.doorway.api import seed_site; "
                    "print(asyncio.run(seed_site(sys.argv[1])))",
                    url,
                ],
                cwd=BACKEND,
                env=env,
                capture_output=True,
                text=True,
            )
            print(f"seed {url}: {seed.stdout.strip() or seed.stderr.strip()[-300:]}")
        print("Ctrl-C to stop.")
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
        while all(proc.poll() is None for proc in procs):
            time.sleep(1)
        print("a process exited; stopping the stack")
    except KeyboardInterrupt:
        pass
    finally:
        for proc in reversed(procs):
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if args.db == "local":
            subprocess.run(["pg_ctl", "-D", str(DEVDB), "-m", "fast", "stop"], capture_output=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
