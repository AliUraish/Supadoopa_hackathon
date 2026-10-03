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

import json
from typing import Any

import mcp_types as types
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from . import broker
from .interfaces import DoorwayStore

SEPARATOR = "__"  # site ids are [a-z0-9-], so this never appears in one


def _text(text: str, *, error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(text=text)], is_error=error)


def _mcp_tool(tool: dict, site_name: str, *, prefixed: bool) -> types.Tool:
    spec = tool.get("spec") or {}
    schema = dict(spec.get("input_schema") or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    price = (
        f" Costs ${broker.price_usd(tool)} per call: returns a paymentLink to pay (MPP) and run it."
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


def build_server(store: DoorwayStore, site_id: str | None = None) -> Server:
    """An MCP server over the store's verified tools: all sites, or just `site_id`."""

    async def list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
        names = {s["id"]: s["name"] for s in await store.list_sites()}
        tools = [
            t
            for t in await store.list_tools(site_id)
            if t["status"] in broker.CALLABLE and t.get("spec")
        ]
        return types.ListToolsResult(
            tools=[
                _mcp_tool(t, names.get(t["site_id"], t["site_id"]), prefixed=site_id is None)
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
        tool = await resolve(params.name)
        if tool is None:
            return _text(f"Unknown tool {params.name}", error=True)
        if missing := broker.missing_inputs(tool, args):
            return _text(f"Missing required inputs: {', '.join(missing)}", error=True)
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
        outcome = await broker.run_tool(store, tool, args, mode="broker")
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
        "return a paymentLink (pay per call with MPP).",
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
