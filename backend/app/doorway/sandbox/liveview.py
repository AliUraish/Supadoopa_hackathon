# ruff: noqa: E501  (embedded HTML page)
"""Live view: watch every sandbox's browser while it explores, verifies, heals or races.

The sandbox process serves it on $PORT (Supabase Compute's public URL):
  GET /             grid of sandboxes, frames refresh about once a second
  GET /frame/{id}   latest JPEG of that sandbox's active page
  GET /state        JSON: per sandbox job, site, page URL, frame age
Contexts are tagged with the sandbox that opened them (the worker sets current_sandbox).
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from contextvars import ContextVar

from starlette.applications import Starlette
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route

from .. import browser

current_sandbox: ContextVar[str | None] = ContextVar("current_sandbox", default=None)
JOBS: dict[str, dict] = {}  # sandbox id -> {"kind", "job_id", "site_id"} while busy
FRAMES: dict[str, dict] = {}  # sandbox id -> {"jpeg", "url", "at"}
_live: dict[object, str] = {}  # open BrowserContext -> sandbox id
FRAME_INTERVAL_S = 0.8
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
                FRAMES[sandbox_id] = {"jpeg": jpeg, "url": page.url, "at": time.time()}
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
tick(); setInterval(tick, 1000);
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
        body = {"pipeline": PIPELINE, "active": active, "sandboxes": _state(ids), "events": events}
        # Read-only, public: the dashboard on any origin polls it.
        headers = {"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"}
        return JSONResponse(body, headers=headers)

    async def frame(request):
        shot = FRAMES.get(request.path_params["sandbox"])
        if shot is None:
            return Response(status_code=404)
        return Response(
            shot["jpeg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"}
        )

    async def health(_request):
        return JSONResponse({"ok": True, "sandboxes": ids})

    return Starlette(
        routes=[
            Route("/", index),
            Route("/state", state),
            Route("/frame/{sandbox}", frame),
            Route("/health", health),
        ]
    )


async def serve(ids: list[str], port: int, stop: asyncio.Event, store=None) -> None:
    import uvicorn

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
