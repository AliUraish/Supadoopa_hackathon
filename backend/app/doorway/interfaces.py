"""Shared contracts for every Doorway module. Code against these; don't redefine them.

Owners: store.py (DoorwayStore impls) · spec.py/executor.py (tool specs + strategies)
· explorer.py + sandbox/ (discovery, verify, heal, optimize, race workers)
· api.py/mcp_server.py (HTTP + MCP) · demo_sites/ (demo websites).

TOOL SPEC (JSON stored in doorway_tools.spec / doorway_tool_versions.spec)
{
  "name": "book_appointment",                     # ^[a-z][a-z0-9_]{1,63}$
  "description": "What it does and when to use it",
  "kind": "action" | "read",                      # actions cost money, reads are free
  "input_schema": {"type": "object", "properties": {...}, "required": [...]},
  "profile_fields": {"patient_name": "full_name", "phone": "phone"},   # optional autofill map
  "strategies": {
    "api": {                                      # replay the site's private JSON call
      "request": {"method": "POST", "path": "api/appointments",  # relative to base_url
                  "query": {"k": "{{input}}"}, "body": {"slot_id": "{{slot_id}}"}},
      "response": {"select": "appointment"}       # dot path of the useful part
    },
    "form": {                                     # fill + submit one form in a browser
      "path": "",                                 # page relative to base_url
      "fields": [{"selector": "#name", "value": "{{patient_name}}", "action": "fill|select|click"}],
      "submit": "#book",
      "result": {"selector": "#result"}           # text read back as the result
    },
    "browser": {                                  # full recorded click path (fallback)
      "steps": [{"action": "goto|click|fill|select|wait", "selector": "...", "value": "{{x}}",
                 "path": ""}],
      "result": {"selector": "#result"}
    }
  },
  "preferred": "api",                             # set by the optimizer
  "test": {"input": {"slot_id": "{{from:list_open_slots:0.id}}", "patient_name": "Doorway Verifier",
                     "phone": "000-0000"}}
}
Legacy specs with top-level "request"/"response" (the Node prototype's format) are the
"api" strategy. {{name}} placeholders take inputs; a string that is only a placeholder keeps
the value's type. {{from:<tool>:<dot.path>}} in tests reuses an earlier tool's test output.
Specs are declarative recipes, never code: the executor only does HTTP to the site's own
origin (SSRF guard) or drives a sandboxed browser.

PATTERN TEMPLATE (doorway_patterns.template): {"roles": {"list_resources": <spec>,
"list_slots": <spec>, "book_slot": <spec>}, "signature": {...}} where specs use role-level
names/descriptions/input schemas shared across sites; the per-site "strategies" are filled
in when a sandbox adopts the pattern on a new site.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Strategy = Literal["api", "form", "browser"]
STRATEGIES: tuple[Strategy, ...] = ("api", "form", "browser")

# How often clients refresh the sandboxes' live view (state + frames). Backend-owned.
LIVE_REFRESH_MS = 2000

JOB_PRIORITY = {"heal": 100, "race": 80, "verify": 50, "optimize": 20, "discover": 10}

EVENT_KINDS = (
    "request.received", "lookup.hit", "lookup.miss", "discover.start", "explore.action",
    "explore.api", "observe.capability", "compile.tool", "reuse.pattern", "verify.start",
    "verify.pass", "verify.fail", "publish.tool", "optimize.result", "execute.call",
    "payment.challenge", "payment.paid", "tool.broken", "heal.start", "heal.done", "heal.fail",
    "sandbox.online", "sandbox.offline",
)  # fmt: skip
MESSAGE_KINDS = ("hello", "tool_published", "pattern_published", "need_tool", "validated", "broken")


@dataclass
class ExecResult:
    ok: bool
    strategy: Strategy | None = None
    data: Any = None
    error: str | None = None
    status: int = 0  # HTTP status for api; 0 otherwise
    ms: int = 0
    steps: int = 1
    # True when the failure means the tool no longer matches the site (needs healing),
    # False when the caller's input was bad or the slot was taken.
    broken: bool = False


@dataclass
class VerifyResult:
    name: str
    passed: bool
    strategy: Strategy | None = None
    ms: int = 0
    status: int = 0
    error: str | None = None
    sample: str | None = None
    by_strategy: dict[str, dict] = field(default_factory=dict)  # {"api": {"passed", "ms"}}


class Executor(Protocol):
    """Implemented in app/doorway/executor.py as module-level async functions."""

    async def execute(
        self,
        spec: dict,
        inputs: dict,
        base_url: str,
        *,
        strategy: Strategy | None = None,  # None = spec["preferred"], falling back in order
        browser: Any = None,  # a playwright Browser for form/browser strategies
    ) -> ExecResult: ...

    async def verify(
        self, specs: list[dict], base_url: str, *, browser: Any = None, strategies=STRATEGIES
    ) -> list[VerifyResult]: ...

    async def benchmark(
        self, spec: dict, inputs: dict, base_url: str, *, browser: Any = None, runs: int = 3
    ) -> dict[str, dict]:  # {"api": {"passed": True, "p50_ms": 84}, ...}
        ...


class DoorwayStore(Protocol):
    """Central memory. SupabaseStore (PostgREST + RPC) and MemoryStore in app/doorway/store.py.

    Rows are plain dicts shaped like the tables in supabase/migrations/*_doorway.sql and the
    objects in backend/DOORWAY_API.md. Writes return the written row.
    """

    # sites
    async def upsert_site(self, site: dict) -> dict: ...
    async def get_site(self, site_id: str) -> dict | None: ...
    async def list_sites(self) -> list[dict]: ...
    async def set_site_status(self, site_id: str, status: str) -> None: ...

    # capabilities
    async def upsert_capability(self, cap: dict) -> dict: ...  # unique (site_id, name)
    async def list_capabilities(self, site_id: str | None = None) -> list[dict]: ...

    # tools + versions
    async def upsert_tool(self, tool: dict) -> dict: ...  # unique (site_id, name)
    async def get_tool(self, tool_id: int) -> dict | None: ...
    async def find_tool(self, site_id: str, name: str) -> dict | None: ...
    async def list_tools(self, site_id: str | None = None) -> list[dict]: ...
    async def set_tool_status(self, tool_id: int, status: str) -> None: ...
    async def publish_version(
        self, tool_id: int, spec: dict, *, source: str, verified_by: str | None, strategies: dict
    ) -> dict: ...  # inserts version N+1 (status verified), updates tool.version/spec/status
    async def list_versions(self, tool_id: int) -> list[dict]: ...
    async def update_tool_stats(self, tool_id: int, fields: dict) -> None: ...

    # patterns (shared memory)
    async def create_pattern(self, pattern: dict) -> dict: ...  # unique name; returns existing
    async def list_patterns(self) -> list[dict]: ...
    async def pattern_used(self, pattern_id: int, site_id: str, success: bool) -> None: ...

    # lessons (shared memory of fixed mistakes; only approved ones reach explorer prompts)
    async def list_lessons(
        self, status: str | None = None, scope: str | None = None
    ) -> list[dict]: ...
    async def propose_lesson(self, lesson: dict) -> dict | None: ...  # None if duplicate
    async def set_lesson_status(self, lesson_id: int, status: str) -> None: ...

    # job queue
    async def enqueue_job(self, job: dict) -> dict: ...  # sets priority from JOB_PRIORITY
    async def claim_job(self, sandbox_id: str, kinds: list[str] | None = None) -> dict | None: ...
    async def finish_job(
        self, job_id: int, *, ok: bool, result: dict | None = None, error: str | None = None
    ) -> None: ...
    async def list_jobs(self, status: str | None = None, limit: int = 100) -> list[dict]: ...
    async def requeue_stale(self, seconds: int = 60) -> int: ...

    # sandboxes + messages
    async def heartbeat(self, sandbox: dict) -> None: ...  # upsert id/status/current_job...
    async def list_sandboxes(self) -> list[dict]: ...
    async def post_message(self, message: dict) -> dict: ...
    async def list_messages(self, since: int = 0, to: str | None = None) -> list[dict]: ...

    # runs, races, requests, events
    async def record_run(self, run: dict) -> dict: ...
    async def list_runs(self, tool_id: int | None = None, limit: int = 50) -> list[dict]: ...
    async def create_race(self, race: dict) -> dict: ...
    async def update_race(self, race_id: str, fields: dict) -> None: ...
    async def get_race(self, race_id: str) -> dict | None: ...
    async def create_request(self, req: dict) -> dict: ...
    async def update_request(self, request_id: str, fields: dict) -> None: ...
    async def get_request(self, request_id: str) -> dict | None: ...
    async def emit(
        self, site_id: str | None, kind: str, message: str, data: dict | None = None,
        sandbox_id: str | None = None,
    ) -> dict: ...  # fmt: skip
    async def list_events(
        self, site_id: str | None = None, since: int = 0, limit: int = 200
    ) -> list[dict]: ...

    # profiles + consent
    async def get_profile(self, user_id: str) -> dict: ...  # {"fields": {...}}
    async def save_profile(self, user_id: str, fields: dict) -> dict: ...
    async def list_consents(self, user_id: str) -> list[dict]: ...
    async def grant_consent(self, user_id: str, site_id: str, fields: list[str]) -> dict: ...
    async def revoke_consent(self, user_id: str, consent_id: int) -> None: ...
