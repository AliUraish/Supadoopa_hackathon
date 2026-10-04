# ruff: noqa: E501  (embedded HTML page)
"""Live view: watch every sandbox's browser while it explores, verifies, heals or races.

The sandbox process serves it on $PORT (Supabase Compute's public URL):
  GET /             grid of sandboxes, frames refresh every LIVE_REFRESH_MS (2 s)
  GET /frame/{id}   latest JPEG of that sandbox's active page
  GET /state        JSON: per sandbox job, site, page URL, frame age, needs_human, viewport
Contexts are tagged with the sandbox that opened them (the worker sets current_sandbox).

Interactive sign-in: on a login wall / CAPTCHA / 2FA the explorer calls wait_for_human, which
keeps the browser open and waits (HUMAN_WAIT_S) for a person to take over from the dashboard:
  POST /takeover/{id}/claim     Bearer <Supabase token> -> {control_token, viewport, expires_at}
  GET  /stream/{id}?token=      MJPEG of the page (~8 fps) for the claimer
  POST /input/{id}              X-Takeover-Token: click / type / key / scroll -> 204
  POST /takeover/{id}/done      save the session (encrypted, per user+site), explore on
  POST /takeover/{id}/cancel    fail the job ("sign-in cancelled")
Typed text is never logged; only the resulting session is kept (see ..sessions).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from ...billing.config import get_settings
from .. import browser, explorer, sessions
from ..interfaces import LIVE_REFRESH_MS

current_sandbox: ContextVar[str | None] = ContextVar("current_sandbox", default=None)
JOBS: dict[str, dict] = {}  # sandbox id -> {"kind", "job_id", "site_id"} while busy
FRAMES: dict[str, dict] = {}  # sandbox id -> {"jpeg", "url", "at"}
_live: dict[object, str] = {}  # open BrowserContext -> sandbox id
FRAME_INTERVAL_S = LIVE_REFRESH_MS / 1000  # clients poll /state at the same pace
PIPELINE = ["Request", "Discover", "Observe", "Compile", "Verify", "Publish", "Optimize",
            "Execute", "Pay", "Heal"]  # fmt: skip
STAGES = {  # job kind -> pipeline stages it is working through
    "discover": ["Discover", "Observe", "Compile"],
    "verify": ["Verify", "Publish"],
    "optimize": ["Optimize"],
    "heal": ["Heal", "Verify", "Publish"],
    "race": ["Execute"],
}


def _track(context) -> None:
    sandbox_id = current_sandbox.get()
    if sandbox_id is None:
        return
    _live[context] = sandbox_id
    context.on("close", lambda *_: _live.pop(context, None))


browser.CONTEXT_HOOKS.append(_track)

log = logging.getLogger(__name__)
HUMAN_WAIT_S = 600
STREAM_FPS = 8
KEYS = {"Enter", "Tab", "Backspace", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft",
        "ArrowRight", "Home", "End", "PageUp", "PageDown"}  # fmt: skip
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Takeover-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}
STORE: Any = None  # set by serve(): human.needed / human.done events


@dataclass
class Takeover:
    page: Any
    reason: str
    job_id: Any
    site_id: str | None
    since: float
    expires_at: float
    done: asyncio.Event = field(default_factory=asyncio.Event)
    outcome: str | None = None  # "done" | "cancel"
    user_id: str | None = None  # whoever claimed it; the session is saved for them
    token: str | None = None


TAKEOVERS: dict[str, Takeover] = {}  # sandbox id -> its pause on a sign-in wall


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat()


def _active(t: Takeover) -> Any:
    """The page to show/drive: the newest open one (sign-in popups open new pages)."""
    pages = [p for p in t.page.context.pages if not p.is_closed()]
    return pages[-1] if pages else t.page


async def _emit(site_id: str | None, kind: str, message: str, data: dict) -> None:
    if STORE is not None and site_id:
        with contextlib.suppress(Exception):
            await STORE.emit(site_id, kind, message, data)


async def wait_for_human(page: Any, reason: str) -> None:
    """explorer.HUMAN: hold this sandbox's job on a sign-in wall until a person finishes."""
    sid = current_sandbox.get()
    if sid is None:
        raise explorer.NeedHuman(f"the site shows {reason}; a person has to sign in first")
    job, now = JOBS.get(sid) or {}, time.time()
    t = Takeover(page, reason, job.get("job_id"), job.get("site_id"), now, now + HUMAN_WAIT_S)
    TAKEOVERS[sid] = t
    data = {"sandbox_id": sid, "job_id": t.job_id, "reason": reason}
    await _emit(t.site_id, "human.needed", f"{sid} needs a person to get past {reason}", data)
    try:
        await asyncio.wait_for(t.done.wait(), HUMAN_WAIT_S)
    except TimeoutError:
        t.outcome = "timeout"
    finally:
        TAKEOVERS.pop(sid, None)
    if t.outcome != "done":
        why = "sign-in cancelled" if t.outcome == "cancel" else "nobody signed in within 10 minutes"
        await _emit(t.site_id, "human.done", f"{sid}: {why}", {**data, "ok": False})
        raise explorer.NeedHuman(why)
    state = await page.context.storage_state()
    sessions.CURRENT.set(state)  # the rest of this job (verify runs) starts signed in
    if t.user_id and t.site_id:
        try:
            await sessions.save(t.user_id, t.site_id, state)
        except Exception:  # noqa: BLE001  (exploring goes on; the session just isn't kept)
            log.exception("saving the session failed")
    message = f"{sid}: signed in; exploring continues"
    await _emit(t.site_id, "human.done", message, {**data, "ok": True})


def _human(sid: str) -> dict | None:
    t = TAKEOVERS.get(sid)
    if t is None:
        return None
    return {
        "reason": t.reason,
        "job_id": t.job_id,
        "site_id": t.site_id,
        "page_url": _active(t).url,
        "since": _iso(t.since),
        "expires_at": _iso(t.expires_at),
        "claimed": t.user_id is not None,
    }


def _control(request, sid: str) -> Takeover | None:
    """The takeover, if the request carries its control token."""
    t = TAKEOVERS.get(sid)
    given = request.headers.get("x-takeover-token") or request.query_params.get("token") or ""
    if t is None or not t.token or not given or not secrets.compare_digest(given, t.token):
        return None
    return t


async def _user_id(request) -> str | None:
    """Supabase user id from the Bearer token (anonymous sessions count), else None."""
    auth = request.headers.get("authorization") or ""
    settings = get_settings()
    key = settings.supabase_publishable_key or settings.supabase_secret_key
    if not auth.lower().startswith("bearer ") or not settings.supabase_url or not key:
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
                headers={"apikey": key, "Authorization": auth},
            )
    except httpx.HTTPError:
        return None
    return response.json().get("id") if response.status_code == 200 else None


def _json(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={**CORS, "Cache-Control": "no-store"})


def _done(status: int = 204) -> Response:
    return Response(status_code=status, headers=CORS)


async def capture(stop: asyncio.Event) -> None:
    """Screenshot each sandbox's newest open page about once a second."""
    while not stop.is_set():
        for context, sandbox_id in list(_live.items()):
            pages = [p for p in context.pages if not p.is_closed()]
            if not pages:
                continue
            page = pages[-1]
            with contextlib.suppress(Exception):  # page navigating or closing mid-shot
                jpeg = await page.screenshot(type="jpeg", quality=55, timeout=1500)
                FRAMES[sandbox_id] = {
                    "jpeg": jpeg,
                    "url": page.url,
                    "at": time.time(),
                    "viewport": page.viewport_size,
                }
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), FRAME_INTERVAL_S)


def _state(ids: list[str]) -> list[dict]:
    now = time.time()
    return [
        {
            "sandbox": sid,
            "job": JOBS.get(sid),
            "url": FRAMES.get(sid, {}).get("url"),
            "frame_age_s": round(now - FRAMES[sid]["at"], 1) if sid in FRAMES else None,
            "live": any(v == sid for v in _live.values()),
            "needs_human": _human(sid),
            "viewport": FRAMES.get(sid, {}).get("viewport"),
        }
        for sid in ids
    ]


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Doorway sandboxes</title>
<style>
body{margin:0;font:14px system-ui;background:#0b1020;color:#e5e7eb}
header{padding:12px 16px;border-bottom:1px solid #1f2937;display:flex;gap:12px;align-items:center}
h1{margin:0;font-size:17px}#sub{color:#9ca3af}
.pipe{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid #1f2937}
.stage{padding:5px 10px;border-radius:999px;background:#111827;border:1px solid #1f2937;
color:#9ca3af;font-size:12px}
.stage.on{background:#14532d;border-color:#22c55e;color:#dcfce7;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.6}}
.wrap{display:grid;grid-template-columns:1fr 340px;gap:14px;padding:14px}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
.card{background:#111827;border:1px solid #1f2937;border-radius:10px;overflow:hidden}
.top{display:flex;justify-content:space-between;padding:8px 12px;gap:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;
background:#6b7280}.busy .dot{background:#22c55e}
.url{color:#9ca3af;font-size:12px;padding:0 12px 8px;word-break:break-all}
img{display:block;width:100%;aspect-ratio:16/10;object-fit:contain;background:#000}
.empty{aspect-ratio:16/10;display:grid;place-items:center;color:#4b5563;background:#000}
.feed{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:8px 12px;
max-height:80vh;overflow:auto}.ev{padding:6px 0;border-bottom:1px solid #1f2937;font-size:12px}
.ev b{color:#93c5fd}.ev small{color:#6b7280;display:block}
</style></head>
<body><header><h1>Doorway sandboxes · live</h1><span id="sub">connecting…</span></header>
<div class="pipe" id="pipe"></div>
<div class="wrap"><div class="grid" id="grid"></div>
<div class="feed"><b>Workflow events</b><div id="feed"></div></div></div><script>
if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/');
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick() {
  try {
    const st = await (await fetch('state', {cache: 'no-store'})).json();
    every = st.refresh_ms || every;
    $('sub').textContent = st.sandboxes.length + ' sandboxes · ' + st.active.length + ' stages active';
    $('pipe').innerHTML = st.pipeline.map((p) =>
      `<span class="stage ${st.active.includes(p) ? 'on' : ''}">${p}</span>`).join('→');
    $('grid').innerHTML = st.sandboxes.map((s) => {
      const job = s.job ? `${s.job.kind} · ${esc(s.job.site_id)} · job ${s.job.job_id}` : 'idle';
      const img = s.frame_age_s === null ? '<div class="empty">waiting for a job…</div>'
        : `<img alt="" src="frame/${s.sandbox}?t=${Date.now()}">`;
      return `<div class="card ${s.job ? 'busy' : ''}"><div class="top"><b><span class="dot">`
        + `</span>${s.sandbox}</b><span>${job}</span></div><div class="url">${esc(s.url)}</div>${img}</div>`;
    }).join('');
    $('feed').innerHTML = st.events.map((e) => `<div class="ev"><b>${esc(e.kind)}</b> `
      + `${esc(e.message)}<small>${esc(e.sandbox_id || '')} ${esc(e.site_id || '')} `
      + `${esc((e.created_at || '').slice(11, 19))}</small></div>`).join('');
  } catch (e) { $('sub').textContent = 'reconnecting…'; }
}
let every = 2000;
async function loop() { await tick(); setTimeout(loop, every); }
loop();
</script></body></html>"""


def app(ids: list[str], store=None) -> Starlette:
    async def index(_request):
        return HTMLResponse(PAGE)

    async def state(_request):
        events = []
        if store is not None:
            with contextlib.suppress(Exception):
                events = [
                    {
                        k: e.get(k)
                        for k in ("id", "kind", "message", "site_id", "sandbox_id", "created_at")
                    }  # fmt: skip
                    for e in await store.list_events(limit=25)
                ]
        active = sorted({st for job in JOBS.values() for st in STAGES.get(job["kind"], [])})
        body = {
            "pipeline": PIPELINE,
            "active": active,
            "sandboxes": _state(ids),
            "events": events,
            "refresh_ms": LIVE_REFRESH_MS,
        }
        # Read-only, public: the dashboard on any origin polls it.
        headers = {"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"}
        return JSONResponse(body, headers=headers)

    async def frame(request):
        sid = request.path_params["sandbox"]
        if sid in TAKEOVERS and _control(request, sid) is None:
            return _done(403)  # a sign-in screen is only for the person taking over
        shot = FRAMES.get(sid)
        if shot is None:
            return Response(status_code=404, headers=CORS)
        headers = {**CORS, "Cache-Control": "no-store"}
        return Response(shot["jpeg"], media_type="image/jpeg", headers=headers)

    async def claim(request):
        if request.method == "OPTIONS":
            return _done()
        t = TAKEOVERS.get(request.path_params["sandbox"])
        if t is None:
            return _json({"error": "not_waiting_for_a_person"}, 404)
        user = await _user_id(request)
        if user is None:
            return _json({"error": "sign_in_required"}, 401)
        if t.user_id and t.user_id != user:
            return _json({"error": "claimed_by_someone_else"}, 409)
        t.user_id, t.token = user, t.token or secrets.token_urlsafe(24)
        viewport = _active(t).viewport_size
        return _json(
            {"control_token": t.token, "viewport": viewport, "expires_at": _iso(t.expires_at)}
        )

    async def stream(request):
        sid = request.path_params["sandbox"]
        t = _control(request, sid)
        if t is None:
            return _done(403)

        async def frames():
            while TAKEOVERS.get(sid) is t and not await request.is_disconnected():
                jpeg = None
                with contextlib.suppress(Exception):  # navigating mid-shot
                    jpeg = await _active(t).screenshot(type="jpeg", quality=60, timeout=2000)
                if jpeg:
                    head = f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n"
                    yield head.encode() + jpeg + b"\r\n"
                await asyncio.sleep(1 / STREAM_FPS)

        headers = {**CORS, "Cache-Control": "no-store"}
        media = "multipart/x-mixed-replace; boundary=frame"
        return StreamingResponse(frames(), media_type=media, headers=headers)

    async def send_input(request):
        if request.method == "OPTIONS":
            return _done()
        t = _control(request, request.path_params["sandbox"])
        if t is None:
            return _done(403)
        try:
            body = await request.json()
            kind, page = body.get("type"), _active(t)
            if kind == "click":
                await page.mouse.click(float(body["x"]), float(body["y"]))
            elif kind == "type":
                await page.keyboard.type(str(body.get("text") or "")[:500])
            elif kind == "key" and body.get("key") in KEYS:
                await page.keyboard.press(body["key"])
            elif kind == "scroll":
                await page.mouse.wheel(0, float(body.get("dy") or 0))
            else:
                return _json({"error": "bad_input"}, 400)
        except (KeyError, TypeError, ValueError, AttributeError):
            return _json({"error": "bad_input"}, 400)
        except Exception:  # noqa: BLE001  (page navigating/closed; never log typed text)
            return _json({"error": "page_busy"}, 409)
        return _done()

    async def finish(request):
        if request.method == "OPTIONS":
            return _done()
        action = request.path_params["action"]
        if action not in ("done", "cancel"):
            return _done(404)
        t = _control(request, request.path_params["sandbox"])
        if t is None:
            return _done(403)
        t.outcome = action
        t.done.set()
        return _done()

    async def health(_request):
        return JSONResponse({"ok": True, "sandboxes": ids})

    return Starlette(
        routes=[
            Route("/", index),
            Route("/state", state),
            Route("/frame/{sandbox}", frame),
            Route("/health", health),
            Route("/takeover/{sandbox}/claim", claim, methods=["POST", "OPTIONS"]),
            Route("/takeover/{sandbox}/{action}", finish, methods=["POST", "OPTIONS"]),
            Route("/stream/{sandbox}", stream),
            Route("/input/{sandbox}", send_input, methods=["POST", "OPTIONS"]),
        ]
    )


async def serve(ids: list[str], port: int, stop: asyncio.Event, store=None) -> None:
    import uvicorn

    global STORE
    STORE = store
    explorer.HUMAN = wait_for_human  # people can take over from the dashboard now

    server = uvicorn.Server(
        uvicorn.Config(
            app(ids, store), host="0.0.0.0", port=port, log_level="warning", lifespan="off"
        )
    )
    serving = asyncio.create_task(server.serve())
    capturing = asyncio.create_task(capture(stop))
    await stop.wait()
    server.should_exit = True
    await asyncio.gather(serving, capturing, return_exceptions=True)
