"""Shared plumbing for Doorway's demo websites.

Every site mirrors supabase/compute/clinic/index.mjs: one page built for humans whose JS calls a
private JSON API with relative fetches. The API exists as v1 and v2 (different paths and field
names). POST /admin/version flips it live; the page always ships the client code for the live
version, so humans never notice while hard-coded API clients get 410 "retired". All state is in
memory. /admin/* needs the x-admin-token header (DEMO_ADMIN_TOKEN, else CLINIC_ADMIN_TOKEN).
"""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

PAGES = Path(__file__).parent / "pages"
VERSIONS = ("v1", "v2")

Handler = Callable[[Request], Awaitable[JSONResponse]]
Api = dict[str, dict[str, Handler]]  # {"v1": {"GET api/areas": handler, ...}, "v2": {...}}


class ApiError(Exception):
    """Raised by handlers; answered as {"error": code, **extra} with the given status."""

    def __init__(self, status: int, error: str, **extra: Any) -> None:
        super().__init__(error)
        self.status = status
        self.body = {"error": error, **extra}


class State:
    """The live API version plus named in-memory tables (bookings, holds, ...)."""

    def __init__(self, *tables: str) -> None:
        self.version = "v1"
        self.tables: dict[str, dict[str, dict]] = {name: {} for name in tables}

    def reset(self) -> None:
        self.version = "v1"
        for table in self.tables.values():
            table.clear()

    def snapshot(self) -> dict:
        rows = {name: list(table.values()) for name, table in self.tables.items()}
        return {"version": self.version, **rows}


# --- request helpers -------------------------------------------------------------------


def json(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status)


async def read_body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def obj(body: dict, key: str) -> dict:
    """A nested JSON object, or {} when it is absent or not an object."""
    value = body.get(key)
    return value if isinstance(value, dict) else {}


def to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def valid_date(value: Any) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def require(fields: dict[str, Any], names: dict[str, str] | None = None) -> dict:
    """Strip strings and 422 on blanks. `names` maps keys to the caller's own field names."""
    clean = {
        k: v.strip() if isinstance(v, str) else v if isinstance(v, int) else None
        for k, v in fields.items()
    }
    missing = [(names or {}).get(k, k) for k, v in clean.items() if v is None or v == ""]
    if missing:
        raise ApiError(422, "missing_fields", fields=missing)
    return clean


def check_email(email: str) -> None:
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ApiError(422, "invalid_email")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def admin_token() -> str:
    return os.environ.get("DEMO_ADMIN_TOKEN") or os.environ.get("CLINIC_ADMIN_TOKEN") or ""


# --- clinic-style slots ----------------------------------------------------------------


class SlotBook:
    """Slots like the clinic's: id "<resource>-<YYYY-MM-DD>-<HHMM>"; booking one consumes it."""

    def __init__(self, resources: list[dict], times: list[str], bookings: dict[str, dict]):
        self.resources = {r["id"]: r for r in resources}
        self.times = times
        self.bookings = bookings

    def resource(self, resource_id: Any) -> dict | None:
        return self.resources.get(resource_id) if isinstance(resource_id, str) else None

    def open_slots(self, resource_id: str, day: str) -> list[dict]:
        slots = ({"id": f"{resource_id}-{day}-{t.replace(':', '')}", "time": t} for t in self.times)
        return [s for s in slots if s["id"] not in self.bookings]

    def book(
        self,
        slot_id: Any,
        prefix: str,
        fields: dict[str, Any],
        names: dict[str, str] | None = None,
        check: Callable[[dict, dict], None] | None = None,
    ) -> dict:
        resource_id, _, rest = str(slot_id).partition("-")
        day, _, hhmm = rest.rpartition("-")
        when = f"{hhmm[:2]}:{hhmm[2:]}"
        resource = self.resource(resource_id)
        if not resource or not valid_date(day) or when not in self.times:
            raise ApiError(404, "unknown_slot")
        if slot_id in self.bookings:
            raise ApiError(409, "slot_taken")
        clean = require(fields, names)
        if check:
            check(resource, clean)
        booking = {
            "id": new_id(prefix),
            "slot_id": slot_id,
            "resource_id": resource["id"],
            "resource": resource["name"],
            "date": day,
            "time": when,
            **clean,
            "created_at": now_iso(),
        }
        self.bookings[slot_id] = booking
        return booking


# --- the site app ----------------------------------------------------------------------

# Shared by every page's script, ahead of that version's `client` object.
HELPERS = """\
// API calls are relative, so the page must be served from a path ending in "/".
if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/' + location.search);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
async function get(url) {
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
async function post(url, data) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}
const REASONS = {
  slot_taken: 'that time was just taken, please pick another',
  unknown_slot: 'that time is no longer offered',
  missing_fields: 'please fill in every field',
  invalid_party_size: 'that party is too large for this area',
  invalid_email: 'please enter a valid email address',
  no_copies_available: 'every copy is already on hold',
  unknown_book: 'that title is not in our catalog',
};
const failure = (what, error) =>
  `Could not ${what} (${error}): ${REASONS[error] || 'please try again'}.`;
"""


def page_renderer(filename: str, clients: dict[str, str]) -> Callable[[str], str]:
    """The page ships the client code of the live version only, like a real deploy."""
    html = (PAGES / filename).read_text(encoding="utf-8")
    return lambda version: html.replace("/*CLIENT*/", f"{HELPERS}{clients[version]}")


def build_app(title: str, state: State, api: Api, page: Callable[[str], str]) -> FastAPI:
    """One site: "/" (the human page), /api/* (private API, live version only), /admin/*."""
    app = FastAPI(title=title, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/")
    def index() -> HTMLResponse:
        return HTMLResponse(page(state.version), headers={"cache-control": "no-store"})

    @app.api_route("/api/{path:path}", methods=["GET", "POST"])
    async def private_api(path: str, request: Request) -> JSONResponse:
        key = f"{request.method} api/{path}"
        handler = api[state.version].get(key)
        if handler is None:
            if any(key in routes for routes in api.values()):
                return json({"error": "This API version has been retired"}, 410)
            return json({"error": "not_found"}, 404)
        try:
            return await handler(request)
        except ApiError as e:
            return json(e.body, e.status)

    def authorized(request: Request) -> bool:
        token, given = admin_token(), request.headers.get("x-admin-token", "")
        return bool(token) and secrets.compare_digest(given.encode(), token.encode())

    unauthorized = {"error": "unauthorized"}

    @app.get("/admin/state")
    def admin_state(request: Request) -> JSONResponse:
        return json(state.snapshot()) if authorized(request) else json(unauthorized, 401)

    @app.post("/admin/version")
    async def admin_version(request: Request) -> JSONResponse:
        if not authorized(request):
            return json(unauthorized, 401)
        version = (await read_body(request)).get("version")
        if version not in VERSIONS:
            return json({"error": "version must be v1 or v2"}, 400)
        state.version = version
        return json({"version": version})

    @app.post("/admin/reset")
    def admin_reset(request: Request) -> JSONResponse:
        if not authorized(request):
            return json(unauthorized, 401)
        state.reset()
        return json({"version": state.version})

    return app


# --- serving ---------------------------------------------------------------------------


@dataclass
class Running:
    server: uvicorn.Server
    thread: threading.Thread
    url: str

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


def start_server(
    app: FastAPI, host: str = "127.0.0.1", port: int = 0, log_level: str = "warning"
) -> Running:
    """Serve `app` from a background thread (port 0 picks a free one); returns once listening."""
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level=log_level))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            server.should_exit = True
            raise RuntimeError(f"could not serve on {host}:{port}")
        time.sleep(0.02)
    bound = server.servers[0].sockets[0].getsockname()[1]
    shown = "localhost" if host in ("0.0.0.0", "::", "") else host
    return Running(server, thread, f"http://{shown}:{bound}/")
