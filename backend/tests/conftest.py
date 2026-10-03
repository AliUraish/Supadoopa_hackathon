"""Test harness. Nothing here touches real Stripe or Supabase.

- stripe-mock (brew install stripe/stripe-mock/stripe-mock) stands in for the Stripe API.
- Postgres 16 + PostgREST run the real migration for store/RLS tests.
Tests needing a missing binary are skipped, never faked.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.billing import config

# Never read the developer's real .env (it holds real keys) during tests.
config.Settings.model_config["env_file"] = None

from app.billing import auth, mpp, routes, store, stripe_client  # noqa: E402
from app.main import app  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = REPO_ROOT / "supabase" / "migrations" / "20261003200000_billing.sql"
STUB_SQL = Path(__file__).parent / "sql" / "supabase_stub.sql"
JWT_SECRET = "test-jwt-secret-that-is-at-least-32-characters"

ENV_NAMES = [
    "STRIPE_SECRET_KEY",
    "STRIPE_API_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PROFILE_ID",
    "STRIPE_API_BASE",
    "MPP_SECRET_KEY",
    "MPP_REALM",
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_REST_URL",
    "APP_URL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SITE_URL",
    "CORS_ORIGINS",
]

USER_ID = "11111111-1111-4111-8111-111111111111"
OTHER_USER_ID = "22222222-2222-4222-8222-222222222222"


def clear_caches() -> None:
    config.get_settings.cache_clear()
    stripe_client.get_stripe.cache_clear()
    mpp.get_mpp.cache_clear()
    store._supabase_store.cache_clear()
    routes._price_ids.clear()
    mpp._local_references.clear()


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    clear_caches()
    yield
    app.dependency_overrides.clear()
    clear_caches()


@pytest.fixture
def configure(monkeypatch):
    def _configure(**env: str) -> None:
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        clear_caches()

    return _configure


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def memory_store():
    memory = store.MemoryStore()
    app.dependency_overrides[store.get_store] = lambda: memory
    return memory


@pytest.fixture
def signed_in():
    user = auth.User(id=USER_ID, email="dev@example.com")
    app.dependency_overrides[auth.current_user] = lambda: user
    return user


# --- external processes ------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_http(url: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            httpx.get(url, timeout=1.0)
            return
        except httpx.HTTPError:
            time.sleep(0.1)
    raise RuntimeError(f"{url} did not come up")


@pytest.fixture(scope="session")
def stripe_mock_url():
    binary = shutil.which("stripe-mock")
    if not binary:
        pytest.skip("stripe-mock not installed")
    port = _free_port()
    proc = subprocess.Popen(
        [binary, "-http-port", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    url = f"http://127.0.0.1:{port}"
    try:
        _wait_http(url)
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=10)


@pytest.fixture
def stripe_mock(stripe_mock_url, configure):
    configure(STRIPE_SECRET_KEY="sk_test_123", STRIPE_API_BASE=stripe_mock_url)
    return stripe_mock_url


def make_jwt(claims: dict, secret: str = JWT_SECRET) -> str:
    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"exp": int(time.time()) + 3600, **claims}).encode())
    signature = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{b64(signature)}"


@pytest.fixture(scope="session")
def postgrest(tmp_path_factory):
    """Postgres 16 with the Supabase stub + billing migration, served by PostgREST."""
    for binary in ("initdb", "pg_ctl", "psql", "postgrest"):
        if not shutil.which(binary):
            pytest.skip(f"{binary} not installed")

    root = tmp_path_factory.mktemp("pg")
    data_dir = root / "data"
    pg_port, rest_port = _free_port(), _free_port()
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "check": True}

    subprocess.run(["initdb", "-D", str(data_dir), "-U", "postgres", "--auth=trust"], **quiet)
    subprocess.run(
        [
            "pg_ctl",
            "-D",
            str(data_dir),
            "-w",
            "-l",
            str(root / "pg.log"),
            "start",
            "-o",
            # TCP only: macOS caps unix socket paths at 103 bytes and tmp paths are longer.
            f"-p {pg_port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''",
        ],
        **quiet,
    )
    rest = None
    try:
        psql = [
            "psql",
            "-h",
            "127.0.0.1",
            "-p",
            str(pg_port),
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
        ]
        subprocess.run([*psql, "-f", str(STUB_SQL)], **quiet)
        result = subprocess.run([*psql, "-f", str(MIGRATION)], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"migration failed:\n{result.stderr}")

        env = {
            **os.environ,
            "PGRST_DB_URI": f"postgres://authenticator@127.0.0.1:{pg_port}/postgres",
            "PGRST_DB_SCHEMAS": "public",
            "PGRST_DB_ANON_ROLE": "anon",
            "PGRST_JWT_SECRET": JWT_SECRET,
            "PGRST_SERVER_HOST": "127.0.0.1",
            "PGRST_SERVER_PORT": str(rest_port),
        }
        rest = subprocess.Popen(
            ["postgrest"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        url = f"http://127.0.0.1:{rest_port}"
        _wait_http(url)
        yield {"url": url, "psql": psql}
    finally:
        if rest:
            rest.terminate()
            rest.wait(timeout=10)
        subprocess.run(["pg_ctl", "-D", str(data_dir), "-m", "immediate", "stop"], **quiet)


@pytest.fixture
def pg_store(postgrest):
    """A SupabaseStore on the local PostgREST, with fresh tables and two auth users."""
    subprocess.run(
        [
            *postgrest["psql"],
            "-c",
            "truncate public.billing_customers, public.billing_subscriptions, "
            "public.billing_purchases, public.billing_events, public.billing_mpp_payments; "
            "delete from auth.users; "
            f"insert into auth.users (id, email) values ('{USER_ID}', 'dev@example.com'), "
            f"('{OTHER_USER_ID}', 'other@example.com');",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return store.SupabaseStore(postgrest["url"], make_jwt({"role": "service_role"}))


@pytest.fixture
def anyio_backend():
    return "asyncio"
