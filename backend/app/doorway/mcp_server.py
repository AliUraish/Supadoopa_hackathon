"""Doorway's tools over MCP (stateless streamable HTTP, JSON responses).

POST /doorway/mcp                every verified tool, named <site_id>__<tool>
POST /doorway/sites/{id}/mcp     one site's verified tools, plain names

    claude mcp add --transport http doorway http://localhost:8000/doorway/mcp

Reads run through the broker. Paid actions don't run over MCP (JSON-RPC can't carry an HTTP
402): they return a paymentLink to POST /doorway/run/<site>/<tool>, Stripe's MCP pattern.
Each request gets a fresh low-level Server bound to the store, so nothing is shared between
requests and no app lifespan is needed.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import mcp_types as types
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from . import broker
from .interfaces import DoorwayStore

SEPARATOR = "__"  # site ids are [a-z0-9-], so this never appears in one
WAIT_MAX_S = 50  # one doorway_get_tools call stays under serverless time limits
WAIT_POLL_S = 2.0

# On the all-sites server: let an agent ask for tools for any website, wait for them, and call
# them by name, all without a client re-listing (new tools appear after tools/list was read).
META_TOOLS = [
    types.Tool(
        name="doorway_create_tools",
        description="Ask Doorway to turn a website into verified tools (a sandbox explores "
        "it, builds and tests them). Give the site's URL, or a known site's id or name, and "
        "what you want to do there. Returns the site_id and any tools that already exist; "
        "then call doorway_get_tools(site_id) to wait for the new ones.",
        input_schema={
            "type": "object",
            "properties": {
                "website": {"type": "string", "description": "URL, or a known site id/name"},
                "goal": {"type": "string", "description": "what to do on the site"},
            },
            "required": ["website", "goal"],
        },
    ),
    types.Tool(
        name="doorway_get_tools",
        description="Wait (up to wait_seconds, max 50) until a site's tools are ready and "
        "return them with their input schemas. If status is still 'working', call it again. "
        "Run a returned tool with doorway_call_tool.",
        input_schema={
            "type": "object",
            "properties": {
                "site_id": {"type": "string"},
                "wait_seconds": {"type": "integer", "minimum": 0, "maximum": WAIT_MAX_S},
            },
            "required": ["site_id"],
        },
    ),
    types.Tool(
        name="doorway_call_tool",
        description="Run a Doorway tool by its full name (<site_id>__<tool>, as returned by "
        "doorway_get_tools) with its arguments. Works for tools created after this session "
        "listed its tools.",
        input_schema={
            "type": "object",
            "properties": {
                "tool": {"type": "string", "description": "<site_id>__<tool>"},
                "arguments": {"type": "object"},
            },
            "required": ["tool"],
        },
    ),
]


def _text(text: str, *, error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(text=text)], is_error=error)


def _mcp_tool(tool: dict, site_name: str, *, prefixed: bool, owner: bool = False) -> types.Tool:
    spec = tool.get("spec") or {}
    schema = dict(spec.get("input_schema") or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    how = (
        "runs directly, paid automatically in Stripe test mode"
        if owner
        else "returns a paymentLink to pay (MPP) and run it"
    )
    price = (
        f" Costs ${broker.price_usd(tool)} per call: {how}."
        if tool["kind"] == "action"
        else " Free."
    )
    name = f"{tool['site_id']}{SEPARATOR}{tool['name']}" if prefixed else tool["name"]
    return types.Tool(
        name=name,
        description=f"{tool.get('description') or spec.get('description', '')} "
        f"(on {site_name}.{price})",
        input_schema=schema,
    )


def build_server(store: DoorwayStore, site_id: str | None = None, *, pay=None) -> Server:
    """An MCP server over the store's verified tools: all sites, or just `site_id`.

    `pay(tool) -> {"reference", ...}` is set for the owner's own Claude (X-Doorway-Key): action
    tools then pay themselves (Stripe test mode) and run, instead of returning a paymentLink.
    """

    async def list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
        names = {s["id"]: s["name"] for s in await store.list_sites()}
        tools = [
            t
            for t in await store.list_tools(site_id)
            if t["status"] in broker.CALLABLE and t.get("spec")
        ]
        meta = META_TOOLS if site_id is None else []
        return types.ListToolsResult(
            tools=meta
            + [
                _mcp_tool(
                    t,
                    names.get(t["site_id"], t["site_id"]),
                    prefixed=site_id is None,
                    owner=pay is not None,
                )
                for t in tools
            ]
        )

    async def resolve(name: str) -> dict | None:
        site, tool_name = (site_id, name) if site_id else name.partition(SEPARATOR)[::2]
        if not site or not tool_name:
            return None
        tool = await store.find_tool(site, tool_name)
        # Broken tools stay callable: the broker heals them on the call.
        return tool if tool and tool["status"] != "draft" and tool.get("spec") else None

    async def call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        args = params.arguments or {}
        if site_id is None and params.name == "doorway_create_tools":
            return await create_tools(args)
        if site_id is None and params.name == "doorway_get_tools":
            return await get_tools(args)
        if site_id is None and params.name == "doorway_call_tool":
            arguments = args.get("arguments") or {}
            return await run(str(args.get("tool") or ""), arguments)
        return await run(params.name, args)

    async def site_tools(site: str) -> list[dict]:
        names = {s["id"]: s["name"] for s in await store.list_sites()}
        return [
            {
                "name": f"{t['site_id']}{SEPARATOR}{t['name']}",
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for t in await store.list_tools(site)
            if t["status"] in broker.CALLABLE and t.get("spec")
            for tool in [_mcp_tool(t, names.get(site, site), prefixed=True, owner=pay is not None)]
        ]

    async def create_tools(args: dict) -> types.CallToolResult:
        website, goal = str(args.get("website") or ""), str(args.get("goal") or "")
        if not website or not goal:
            return _text("Give both website and goal", error=True)
        try:
            request, _ = await broker.handle_request(store, website, goal)
        except ValueError as error:
            return _text(f"Invalid website: {error}", error=True)
        site = request["site_id"]
        tools = await site_tools(site)
        status = "ready" if request["status"] != "discovering" else "working"
        note = (
            "A matching verified tool exists already."
            if status == "ready"
            else "Doorway is building tools for this site now. "
            f"Call doorway_get_tools(site_id='{site}') to wait for them."
        )
        body = {"site_id": site, "status": status, "note": note, "tools": tools}
        return _text(json.dumps(body))

    async def get_tools(args: dict) -> types.CallToolResult:
        site = str(args.get("site_id") or "")
        if await store.get_site(site) is None:
            return _text(f"Unknown site {site}; call doorway_create_tools first", error=True)
        wait = min(max(int(args.get("wait_seconds") or WAIT_MAX_S), 0), WAIT_MAX_S)
        deadline = time.monotonic() + wait
        while True:
            row = await store.get_site(site) or {}
            tools = await site_tools(site)
            done = row.get("status") in ("ready", "failed") and (
                tools or row.get("status") == "failed"
            )
            if done or time.monotonic() >= deadline:
                break
            await asyncio.sleep(WAIT_POLL_S)
        events = await store.list_events(site, limit=6)
        body = {
            "site_id": site,
            "status": "ready" if done and tools else "failed" if done else "working",
            "site_status": row.get("status"),
            "tools": tools,
            "recent_progress": [e.get("message") for e in events][-6:],
        }
        if not done:
            body["note"] = "Still building; call doorway_get_tools again."
        return _text(json.dumps(body, default=str))

    async def run(name: str, args: dict) -> types.CallToolResult:
        tool = await resolve(name)
        if tool is None:
            return _text(f"Unknown tool {name}", error=True)
        if missing := broker.missing_inputs(tool, args):
            return _text(f"Missing required inputs: {', '.join(missing)}", error=True)
        if tool["kind"] == "action" and pay is not None:
            try:
                payment = await pay(tool)
            except Exception as error:  # noqa: BLE001  (payment problems go back as text)
                return _text(f"Payment failed: {error}", error=True)
            outcome = await broker.run_tool(
                store, tool, args, mode="broker", paid_reference=payment["reference"], owner=True
            )
            paid = (
                f"(paid ${broker.price_usd(tool)} in Stripe test mode, ref {payment['reference']})"
            )
            if not outcome.ok:
                return _text(f"Error: {outcome.error} {paid}", error=True)
            return _text(json.dumps(outcome.data, default=str) + f"\n{paid}")
        if tool["kind"] == "action":
            link = broker.payment_link(tool, args)
            await store.emit(
                tool["site_id"],
                "execute.call",
                f"Agent called {tool['name']} over MCP: sent a ${broker.price_usd(tool)} "
                "payment link",
                {
                    "tool_id": tool["id"],
                    "tool": tool["name"],
                    "inputs": sorted(args),
                    "mode": "mcp",
                },
            )
            return _text(json.dumps(link))
        outcome = await broker.run_tool(store, tool, args, mode="broker", owner=pay is not None)
        if not outcome.ok:
            return _text(f"Error: {outcome.error}", error=True)
        note = (
            "\n(note: the site changed; Doorway repaired this tool automatically)"
            if outcome.healed
            else ""
        )
        return _text(json.dumps(outcome.data, default=str) + note)

    name = f"doorway-{site_id}" if site_id else "doorway"
    return Server(
        name,
        version="1.0.0",
        instructions="Verified tools for websites without an API. Reads are free; actions "
        + (
            "run directly and are paid automatically (Stripe test mode)."
            if pay is not None
            else "return a paymentLink (pay per call with MPP)."
        ),
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def serve(server: Server, scope: Scope, receive: Receive, send: Send) -> None:
    """Answer one MCP HTTP request statelessly (a fresh transport per request)."""
    manager = StreamableHTTPSessionManager(app=server, json_response=True, stateless=True)
    async with manager.run():
        await manager.handle_request(scope, receive, send)


class MCPResponse(Response):
    """Hands the untouched ASGI request (FastAPI hasn't read the body) to the MCP transport."""

    def __init__(self, server: Server) -> None:
        super().__init__()
        self.server = server

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await serve(self.server, scope, receive, send)
