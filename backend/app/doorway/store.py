"""Doorway's central memory, in the doorway_* tables (supabase/migrations/*_doorway.sql).

SupabaseStore talks to PostgREST with the secret key (bypasses RLS) and uses the
doorway_claim_job / doorway_requeue_stale / doorway_pattern_used RPCs for atomic steps.
MemoryStore mirrors it in-process (defaults, NOT NULL / enum / foreign-key checks) so
code tested against it behaves the same on Postgres.

Both drop keys that are not table columns (e.g. a Site's computed `tools_count`) and never
send `id` for identity tables, so callers can pass rows they read back.
"""

from __future__ import annotations

import copy
import re
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import httpx

from ..billing.config import NotConfigured, get_settings
from ..billing.store import StoreError
from .interfaces import JOB_PRIORITY, MESSAGE_KINDS, STRATEGIES, DoorwayStore

__all__ = [
    "MemoryStore",
    "StoreError",
    "SupabaseStore",
    "doorway_store_cache_clear",
    "get_doorway_store",
]

EVENT_LIMIT = 200
MESSAGE_LIMIT = 200

_ID = "<identity>"  # bigint generated always as identity
_REQ = "<required>"  # not null, no default
_NOW = "<now>"  # default now()

# column -> default. A None default means the column is nullable.
SCHEMA: dict[str, dict[str, Any]] = {
    "doorway_sites": {
        "id": _REQ, "name": _REQ, "base_url": _REQ, "goal": None, "status": "new",
        "is_demo": False, "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_patterns": {
        "id": _ID, "name": _REQ, "description": _REQ, "signature": {}, "template": _REQ,
        "created_by": None, "source_site_id": None, "used_by": [], "success_count": 0,
        "failure_count": 0, "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_capabilities": {
        "id": _ID, "site_id": _REQ, "name": _REQ, "description": _REQ, "kind": _REQ,
        "status": "discovered", "evidence": {}, "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_tools": {
        "id": _ID, "site_id": _REQ, "capability_id": None, "name": _REQ, "description": _REQ,
        "kind": _REQ, "status": "draft", "version": 0, "spec": None, "best_strategy": None,
        "p50_ms": None, "success_rate": None, "runs_count": 0, "price_cents": 0,
        "pattern_id": None, "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_tool_versions": {
        "id": _ID, "tool_id": _REQ, "version": _REQ, "spec": _REQ, "status": _REQ,
        "source": _REQ, "verified_by": None, "strategies": {}, "created_at": _NOW,
    },
    "doorway_sandboxes": {
        "id": _REQ, "status": "idle", "current_job_id": None, "site_id": None, "job_kind": None,
        "jobs_done": 0, "last_heartbeat": _NOW, "started_at": _NOW,
    },
    "doorway_jobs": {
        "id": _ID, "kind": _REQ, "site_id": None, "tool_id": None, "payload": {},
        "status": "queued", "priority": 0, "claimed_by": None, "not_sandbox": None,
        "attempts": 0, "result": None, "error": None, "created_at": _NOW, "started_at": None,
        "finished_at": None,
    },
    "doorway_messages": {
        "id": _ID, "from_sandbox": _REQ, "to_sandbox": None, "kind": _REQ, "body": {},
        "created_at": _NOW,
    },
    "doorway_runs": {
        "id": _ID, "tool_id": None, "site_id": None, "mode": _REQ, "strategy": None,
        "status": _REQ, "ms": None, "steps": None, "tokens": None, "paid_reference": None,
        "error": None, "created_at": _NOW,
    },
    "doorway_races": {
        "id": _REQ, "site_id": None, "task": _REQ, "inputs": {}, "status": "queued",
        "browser": {}, "broker": {}, "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_requests": {
        "id": _REQ, "website": _REQ, "task": _REQ, "site_id": None, "tool_id": None,
        "status": "discovering", "inputs": {}, "result": None, "created_at": _NOW,
        "updated_at": _NOW,
    },
    "doorway_events": {
        "id": _ID, "site_id": None, "sandbox_id": None, "kind": _REQ, "message": _REQ,
        "data": {}, "created_at": _NOW,
    },
    "doorway_profiles": {"user_id": _REQ, "fields": {}, "updated_at": _NOW},
    "doorway_lessons": {
        "id": _ID, "lesson": _REQ, "scope": "explore", "site_id": None, "sandbox_id": None,
        "failure": None, "fix": None, "status": "proposed", "source": "auto",
        "created_at": _NOW, "updated_at": _NOW,
    },
    "doorway_consents": {
        "id": _ID, "user_id": _REQ, "site_id": _REQ, "fields": _REQ, "granted_at": _NOW,
    },
}  # fmt: skip

_QUEUE = ("queued", "running", "done", "failed")
# CHECK constraints from the migration (MemoryStore enforces them; Postgres does anyway).
CHECKS: dict[str, dict[str, tuple[str, ...]]] = {
    "doorway_sites": {
        "status": ("new", "queued", "discovering", "verifying", "ready", "broken", "healing",
                   "failed"),
    },
    "doorway_capabilities": {
        "kind": ("read", "action"),
        "status": ("discovered", "compiled", "verified", "broken", "repairing"),
    },
    "doorway_tools": {
        "kind": ("read", "action"),
        "status": ("draft", "verified", "broken", "repairing"),
        "best_strategy": STRATEGIES,
    },
    "doorway_tool_versions": {
        "status": ("verified", "broken"),
        "source": ("discover", "reuse", "heal", "reverify", "seed"),
    },
    "doorway_sandboxes": {"status": ("idle", "busy", "offline")},
    "doorway_jobs": {"kind": tuple(JOB_PRIORITY), "status": _QUEUE},
    "doorway_messages": {"kind": MESSAGE_KINDS},
    "doorway_runs": {
        "mode": ("broker", "browser_agent", "dashboard", "verify"),
        "strategy": STRATEGIES,
        "status": ("success", "failure"),
    },
    "doorway_races": {"status": _QUEUE},
    "doorway_requests": {"status": ("discovering", "executing", "done", "failed")},
    "doorway_lessons": {
        "scope": ("explore", "spec", "session", "verify"),
        "status": ("proposed", "approved", "rejected"),
        "source": ("auto", "curated"),
    },
}  # fmt: skip
PATTERNS = {
    ("doorway_sites", "id"): re.compile(r"^[a-z0-9-]{2,40}$"),
    ("doorway_tools", "name"): re.compile(r"^[a-z][a-z0-9_]{1,63}$"),
}
# Foreign keys by column name (doorway_sandboxes.site_id is informational, not a FK).
FOREIGN_KEYS = {
    "site_id": "doorway_sites",
    "source_site_id": "doorway_sites",
    "tool_id": "doorway_tools",
    "capability_id": "doorway_capabilities",
    "pattern_id": "doorway_patterns",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _lesson_text(text: Any) -> str:
    return " ".join(str(text or "").split())[:400]


def _clean(table: str, row: dict[str, Any]) -> dict[str, Any]:
    """Only real columns, minus generated identity ids."""
    columns = SCHEMA[table]
    return {k: v for k, v in row.items() if k in columns and (k != "id" or columns[k] != _ID)}


def _job_row(job: dict[str, Any]) -> dict[str, Any]:
    row = _clean("doorway_jobs", job)
    if row.get("priority") is None:
        row["priority"] = JOB_PRIORITY.get(row.get("kind", ""), 0)
    return row


class SupabaseStore:
    def __init__(self, rest_url: str, key: str, *, timeout: float = 10.0) -> None:
        self._url = rest_url.rstrip("/")
        self._timeout = timeout
        self._headers = {"apikey": key}
        # Legacy service_role JWTs also go in Authorization; new sb_secret_ keys must not.
        if key.startswith("eyJ"):
            self._headers["Authorization"] = f"Bearer {key}"

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        prefer: str | None = None,
    ) -> Any:
        headers = dict(self._headers)
        if prefer:
            headers["Prefer"] = prefer
        # A client per call: safe across event loops (tests, serverless reuse).
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.request(
                method, f"{self._url}/{path}", params=params, json=json, headers=headers
            )
        if response.status_code >= 400:
            raise StoreError(f"{method} {path} -> {response.status_code}: {response.text[:300]}")
        return response.json() if response.content else []

    async def _select(self, table: str, order: str | None = None, **filters: Any) -> list[dict]:
        params = {"select": "*"}
        params.update({k: f"eq.{v}" for k, v in filters.items() if v is not None})
        if order:
            params["order"] = order
        return await self._request("GET", table, params=params)

    async def _one(self, table: str, **filters: Any) -> dict | None:
        rows = await self._select(table, **filters)
        return rows[0] if rows else None

    async def _insert(self, table: str, row: dict[str, Any]) -> dict:
        rows = await self._request("POST", table, json=row, prefer="return=representation")
        return rows[0]

    async def _upsert(self, table: str, row: dict[str, Any], conflict: str) -> dict:
        rows = await self._request(
            "POST",
            table,
            params={"on_conflict": conflict},
            json=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return rows[0]

    async def _patch(self, table: str, fields: dict[str, Any], **filters: Any) -> None:
        params = {k: f"eq.{v}" for k, v in filters.items()}
        await self._request("PATCH", table, params=params, json=fields, prefer="return=minimal")

    async def _rpc(self, name: str, args: dict[str, Any]) -> Any:
        return await self._request("POST", f"rpc/{name}", json=args)

    # sites

    async def upsert_site(self, site: dict) -> dict:
        row = {**_clean("doorway_sites", site), "updated_at": _now()}
        return await self._upsert("doorway_sites", row, "id")

    async def get_site(self, site_id: str) -> dict | None:
        return await self._one("doorway_sites", id=site_id)

    async def list_sites(self) -> list[dict]:
        return await self._select("doorway_sites", order="created_at.desc")

    async def set_site_status(self, site_id: str, status: str) -> None:
        await self._patch("doorway_sites", {"status": status, "updated_at": _now()}, id=site_id)

    # capabilities

    async def upsert_capability(self, cap: dict) -> dict:
        row = {**_clean("doorway_capabilities", cap), "updated_at": _now()}
        return await self._upsert("doorway_capabilities", row, "site_id,name")

    async def list_capabilities(self, site_id: str | None = None) -> list[dict]:
        return await self._select("doorway_capabilities", order="id", site_id=site_id)

    # tools + versions

    async def upsert_tool(self, tool: dict) -> dict:
        row = {**_clean("doorway_tools", tool), "updated_at": _now()}
        return await self._upsert("doorway_tools", row, "site_id,name")

    async def get_tool(self, tool_id: int) -> dict | None:
        return await self._one("doorway_tools", id=tool_id)

    async def find_tool(self, site_id: str, name: str) -> dict | None:
        return await self._one("doorway_tools", site_id=site_id, name=name)

    async def list_tools(self, site_id: str | None = None) -> list[dict]:
        return await self._select("doorway_tools", order="id", site_id=site_id)

    async def set_tool_status(self, tool_id: int, status: str) -> None:
        await self._patch("doorway_tools", {"status": status, "updated_at": _now()}, id=tool_id)

    async def publish_version(
        self, tool_id: int, spec: dict, *, source: str, verified_by: str | None, strategies: dict
    ) -> dict:
        tool = await self.get_tool(tool_id)
        if tool is None:
            raise StoreError(f"tool {tool_id} not found")
        version = await self._insert(
            "doorway_tool_versions",
            {
                "tool_id": tool_id,
                "version": tool["version"] + 1,
                "status": "verified",
                "source": source,
                "verified_by": verified_by,
                "strategies": strategies,
                "spec": spec,
            },
        )
        fields = {"version": version["version"], "spec": spec, "status": "verified"}
        await self._patch("doorway_tools", {**fields, "updated_at": _now()}, id=tool_id)
        return version

    async def list_versions(self, tool_id: int) -> list[dict]:
        return await self._select("doorway_tool_versions", order="version.desc", tool_id=tool_id)

    async def update_tool_stats(self, tool_id: int, fields: dict) -> None:
        row = {**_clean("doorway_tools", fields), "updated_at": _now()}
        await self._patch("doorway_tools", row, id=tool_id)

    # patterns

    async def create_pattern(self, pattern: dict) -> dict:
        row = _clean("doorway_patterns", pattern)
        inserted = await self._request(
            "POST",
            "doorway_patterns",
            params={"on_conflict": "name"},
            json=row,
            prefer="resolution=ignore-duplicates,return=representation",
        )
        if inserted:
            return inserted[0]
        existing = await self._one("doorway_patterns", name=row["name"])
        if existing is None:
            raise StoreError(f"pattern {row['name']!r} vanished")
        return existing

    async def list_patterns(self) -> list[dict]:
        return await self._select("doorway_patterns", order="id")

    async def pattern_used(self, pattern_id: int, site_id: str, success: bool) -> None:
        await self._rpc(
            "doorway_pattern_used", {"p_id": pattern_id, "p_site": site_id, "p_success": success}
        )

    # lessons (shared memory: a mistake fixed once is read before every new exploration)

    async def list_lessons(self, status: str | None = None, scope: str | None = None) -> list[dict]:
        filters = {k: v for k, v in (("status", status), ("scope", scope)) if v}
        return await self._select("doorway_lessons", order="id", **filters)

    async def propose_lesson(self, lesson: dict) -> dict | None:
        row = _clean("doorway_lessons", {**lesson, "lesson": _lesson_text(lesson.get("lesson"))})
        if not row["lesson"]:
            return None
        inserted = await self._request(
            "POST",
            "doorway_lessons",
            params={"on_conflict": "lesson"},
            json=row,
            prefer="resolution=ignore-duplicates,return=representation",
        )
        return inserted[0] if inserted else None

    async def set_lesson_status(self, lesson_id: int, status: str) -> None:
        await self._patch("doorway_lessons", {"status": status, "updated_at": _now()}, id=lesson_id)

    # job queue

    async def enqueue_job(self, job: dict) -> dict:
        return await self._insert("doorway_jobs", _job_row(job))

    async def claim_job(self, sandbox_id: str, kinds: list[str] | None = None) -> dict | None:
        rows = await self._rpc(
            "doorway_claim_job",
            {"p_sandbox": sandbox_id, "p_kinds": list(kinds) if kinds is not None else None},
        )
        return rows[0] if rows else None

    async def finish_job(
        self, job_id: int, *, ok: bool, result: dict | None = None, error: str | None = None
    ) -> None:
        fields = {
            "status": "done" if ok else "failed",
            "result": result,
            "error": error,
            "finished_at": _now(),
        }
        await self._patch("doorway_jobs", fields, id=job_id)

    async def list_jobs(self, status: str | None = None, limit: int = 100) -> list[dict]:
        params = {"select": "*", "order": "id.desc", "limit": str(limit)}
        if status:
            params["status"] = f"eq.{status}"
        return await self._request("GET", "doorway_jobs", params=params)

    async def requeue_stale(self, seconds: int = 60) -> int:
        return int(await self._rpc("doorway_requeue_stale", {"p_seconds": seconds}) or 0)

    # sandboxes + messages

    async def heartbeat(self, sandbox: dict) -> None:
        row = {**_clean("doorway_sandboxes", sandbox), "last_heartbeat": _now()}
        await self._request(
            "POST",
            "doorway_sandboxes",
            params={"on_conflict": "id"},
            json=row,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    async def list_sandboxes(self) -> list[dict]:
        return await self._select("doorway_sandboxes", order="id")

    async def post_message(self, message: dict) -> dict:
        return await self._insert("doorway_messages", _clean("doorway_messages", message))

    async def list_messages(self, since: int = 0, to: str | None = None) -> list[dict]:
        params = _since_params(since, MESSAGE_LIMIT)
        if to is not None:
            params["or"] = f'(to_sandbox.is.null,to_sandbox.eq."{to}")'
        return await self._request("GET", "doorway_messages", params=params)

    # runs, races, requests, events

    async def record_run(self, run: dict) -> dict:
        return await self._insert("doorway_runs", _clean("doorway_runs", run))

    async def list_runs(self, tool_id: int | None = None, limit: int = 50) -> list[dict]:
        params = {"select": "*", "order": "id.desc", "limit": str(limit)}
        if tool_id is not None:
            params["tool_id"] = f"eq.{tool_id}"
        return await self._request("GET", "doorway_runs", params=params)

    async def create_race(self, race: dict) -> dict:
        return await self._insert("doorway_races", _clean("doorway_races", race))

    async def update_race(self, race_id: str, fields: dict) -> None:
        row = {**_clean("doorway_races", fields), "updated_at": _now()}
        await self._patch("doorway_races", row, id=race_id)

    async def get_race(self, race_id: str) -> dict | None:
        return await self._one("doorway_races", id=race_id)

    async def create_request(self, req: dict) -> dict:
        return await self._insert("doorway_requests", _clean("doorway_requests", req))

    async def update_request(self, request_id: str, fields: dict) -> None:
        row = {**_clean("doorway_requests", fields), "updated_at": _now()}
        await self._patch("doorway_requests", row, id=request_id)

    async def get_request(self, request_id: str) -> dict | None:
        return await self._one("doorway_requests", id=request_id)

    async def emit(
        self,
        site_id: str | None,
        kind: str,
        message: str,
        data: dict | None = None,
        sandbox_id: str | None = None,
    ) -> dict:
        row = {
            "site_id": site_id,
            "sandbox_id": sandbox_id,
            "kind": kind,
            "message": message,
            "data": data or {},
        }
        return await self._insert("doorway_events", row)

    async def list_events(
        self, site_id: str | None = None, since: int = 0, limit: int = EVENT_LIMIT
    ) -> list[dict]:
        params = _since_params(since, limit)
        if site_id is not None:
            params["site_id"] = f"eq.{site_id}"
        return await self._request("GET", "doorway_events", params=params)

    # profiles + consent

    async def get_profile(self, user_id: str) -> dict:
        row = await self._one("doorway_profiles", user_id=user_id)
        return {"fields": row["fields"] if row else {}}

    async def save_profile(self, user_id: str, fields: dict) -> dict:
        row = {"user_id": user_id, "fields": fields, "updated_at": _now()}
        saved = await self._upsert("doorway_profiles", row, "user_id")
        return {"fields": saved["fields"]}

    async def list_consents(self, user_id: str) -> list[dict]:
        return await self._select("doorway_consents", order="id.desc", user_id=user_id)

    async def grant_consent(self, user_id: str, site_id: str, fields: list[str]) -> dict:
        row = {"user_id": user_id, "site_id": site_id, "fields": fields, "granted_at": _now()}
        return await self._upsert("doorway_consents", row, "user_id,site_id")

    async def revoke_consent(self, user_id: str, consent_id: int) -> None:
        await self._request(
            "DELETE",
            "doorway_consents",
            params={"id": f"eq.{consent_id}", "user_id": f"eq.{user_id}"},
        )


def _since_params(since: int, limit: int) -> dict[str, str]:
    """Latest first by default; with `since`, everything after it, oldest first (polling)."""
    params = {"select": "*", "limit": str(limit)}
    if since:
        params.update({"id": f"gt.{since}", "order": "id.asc"})
    else:
        params["order"] = "id.desc"
    return params


class MemoryStore:
    """In-process DoorwayStore for tests and local runs. Not shared across instances.

    Methods never await mid-update, so each one is atomic under asyncio (claim_job included).
    """

    def __init__(self) -> None:
        self.tables: dict[str, dict[Any, dict[str, Any]]] = {name: {} for name in SCHEMA}
        self._ids: dict[str, int] = dict.fromkeys(SCHEMA, 0)

    # helpers

    def _rows(self, table: str) -> list[dict[str, Any]]:
        return list(self.tables[table].values())

    def _validate(self, table: str, row: dict[str, Any]) -> None:
        columns = SCHEMA[table]
        for column, value in row.items():
            if value is None:
                if columns[column] is not None:
                    raise StoreError(f"{table}.{column} cannot be null")
                continue
            allowed = CHECKS.get(table, {}).get(column)
            if allowed is not None and value not in allowed:
                raise StoreError(f"{table}.{column}: invalid value {value!r}")
            pattern = PATTERNS.get((table, column))
            if pattern is not None and not pattern.match(str(value)):
                raise StoreError(f"{table}.{column}: invalid value {value!r}")
            target = FOREIGN_KEYS.get(column)
            if target and table != "doorway_sandboxes" and value not in self.tables[target]:
                raise StoreError(f"{table}.{column}: {value!r} not in {target}")

    def _full_row(self, table: str, row: dict[str, Any]) -> dict[str, Any]:
        """The row Postgres would insert: defaults filled, constraints checked."""
        full: dict[str, Any] = {}
        now = _now()
        for column, default in SCHEMA[table].items():
            if column in row:
                full[column] = copy.deepcopy(row[column])
            elif default == _REQ:
                raise StoreError(f"{table}.{column} is required")
            elif default == _NOW:
                full[column] = now
            elif default != _ID:
                full[column] = copy.deepcopy(default)
        self._validate(table, full)
        return full

    def _insert(self, table: str, row: dict[str, Any], key: str = "id") -> dict[str, Any]:
        full = self._full_row(table, _clean(table, row))
        if SCHEMA[table].get("id") == _ID:
            self._ids[table] += 1
            full = {"id": self._ids[table], **full}
        if full[key] in self.tables[table]:
            raise StoreError(f"{table}: duplicate {key} {full[key]!r}")
        self.tables[table][full[key]] = full
        return copy.deepcopy(full)

    def _find(self, table: str, **match: Any) -> dict[str, Any] | None:
        for row in self.tables[table].values():
            if all(row.get(k) == v for k, v in match.items()):
                return row
        return None

    def _upsert(self, table: str, row: dict[str, Any], conflict: tuple[str, ...]) -> dict:
        row = _clean(table, row)
        full = self._full_row(table, row)  # Postgres checks the insert tuple first
        existing = self._find(table, **{c: full[c] for c in conflict})
        if existing is None:
            key = "user_id" if table == "doorway_profiles" else "id"
            return self._insert(table, row, key)
        existing.update(copy.deepcopy(row))
        return copy.deepcopy(existing)

    def _update(self, table: str, key: Any, fields: dict[str, Any]) -> None:
        row = self.tables[table].get(key)
        if row is None:
            return
        fields = _clean(table, fields)
        self._validate(table, fields)
        row.update(copy.deepcopy(fields))

    def _get(self, table: str, key: Any) -> dict | None:
        row = self.tables[table].get(key)
        return copy.deepcopy(row) if row else None

    def _list(self, table: str, *, newest_first: bool = False, **match: Any) -> list[dict]:
        rows = [
            r
            for r in self.tables[table].values()
            if all(r.get(k) == v for k, v in match.items() if v is not None)
        ]
        rows.sort(key=lambda r: r["id"], reverse=newest_first)
        return copy.deepcopy(rows)

    # sites

    async def upsert_site(self, site: dict) -> dict:
        return self._upsert("doorway_sites", {**site, "updated_at": _now()}, ("id",))

    async def get_site(self, site_id: str) -> dict | None:
        return self._get("doorway_sites", site_id)

    async def list_sites(self) -> list[dict]:
        rows = self._rows("doorway_sites")[::-1]  # insertion order, newest first
        return copy.deepcopy(sorted(rows, key=lambda r: r["created_at"], reverse=True))

    async def set_site_status(self, site_id: str, status: str) -> None:
        self._update("doorway_sites", site_id, {"status": status, "updated_at": _now()})

    # capabilities

    async def upsert_capability(self, cap: dict) -> dict:
        row = {**cap, "updated_at": _now()}
        return self._upsert("doorway_capabilities", row, ("site_id", "name"))

    async def list_capabilities(self, site_id: str | None = None) -> list[dict]:
        return self._list("doorway_capabilities", site_id=site_id)

    # tools + versions

    async def upsert_tool(self, tool: dict) -> dict:
        return self._upsert("doorway_tools", {**tool, "updated_at": _now()}, ("site_id", "name"))

    async def get_tool(self, tool_id: int) -> dict | None:
        return self._get("doorway_tools", tool_id)

    async def find_tool(self, site_id: str, name: str) -> dict | None:
        row = self._find("doorway_tools", site_id=site_id, name=name)
        return copy.deepcopy(row) if row else None

    async def list_tools(self, site_id: str | None = None) -> list[dict]:
        return self._list("doorway_tools", site_id=site_id)

    async def set_tool_status(self, tool_id: int, status: str) -> None:
        self._update("doorway_tools", tool_id, {"status": status, "updated_at": _now()})

    async def publish_version(
        self, tool_id: int, spec: dict, *, source: str, verified_by: str | None, strategies: dict
    ) -> dict:
        tool = self.tables["doorway_tools"].get(tool_id)
        if tool is None:
            raise StoreError(f"tool {tool_id} not found")
        version = self._insert(
            "doorway_tool_versions",
            {
                "tool_id": tool_id,
                "version": tool["version"] + 1,
                "status": "verified",
                "source": source,
                "verified_by": verified_by,
                "strategies": strategies,
                "spec": spec,
            },
        )
        fields = {"version": version["version"], "spec": spec, "status": "verified"}
        self._update("doorway_tools", tool_id, {**fields, "updated_at": _now()})
        return version

    async def list_versions(self, tool_id: int) -> list[dict]:
        rows = self._list("doorway_tool_versions", tool_id=tool_id)
        return sorted(rows, key=lambda r: r["version"], reverse=True)

    async def update_tool_stats(self, tool_id: int, fields: dict) -> None:
        self._update("doorway_tools", tool_id, {**fields, "updated_at": _now()})

    # patterns

    async def create_pattern(self, pattern: dict) -> dict:
        existing = self._find("doorway_patterns", name=pattern.get("name"))
        if existing is not None:
            return copy.deepcopy(existing)
        return self._insert("doorway_patterns", pattern)

    async def list_patterns(self) -> list[dict]:
        return self._list("doorway_patterns")

    async def pattern_used(self, pattern_id: int, site_id: str, success: bool) -> None:
        row = self.tables["doorway_patterns"].get(pattern_id)
        if row is None:
            return
        if site_id not in row["used_by"]:
            row["used_by"].append(site_id)
        row["success_count" if success else "failure_count"] += 1
        row["updated_at"] = _now()

    # lessons

    async def list_lessons(self, status: str | None = None, scope: str | None = None) -> list[dict]:
        match = {k: v for k, v in (("status", status), ("scope", scope)) if v}
        return self._list("doorway_lessons", **match)

    async def propose_lesson(self, lesson: dict) -> dict | None:
        text = _lesson_text(lesson.get("lesson"))
        if not text or self._find("doorway_lessons", lesson=text) is not None:
            return None
        return self._insert("doorway_lessons", {**lesson, "lesson": text})

    async def set_lesson_status(self, lesson_id: int, status: str) -> None:
        self._update("doorway_lessons", lesson_id, {"status": status, "updated_at": _now()})

    # job queue

    async def enqueue_job(self, job: dict) -> dict:
        return self._insert("doorway_jobs", _job_row(job))

    async def claim_job(self, sandbox_id: str, kinds: list[str] | None = None) -> dict | None:
        queued = [
            j
            for j in self.tables["doorway_jobs"].values()
            if j["status"] == "queued"
            and (kinds is None or j["kind"] in kinds)
            and j["not_sandbox"] != sandbox_id
        ]
        if not queued:
            return None
        job = min(queued, key=lambda j: (-j["priority"], j["id"]))
        job.update(
            status="running", claimed_by=sandbox_id, started_at=_now(), attempts=job["attempts"] + 1
        )
        return copy.deepcopy(job)

    async def finish_job(
        self, job_id: int, *, ok: bool, result: dict | None = None, error: str | None = None
    ) -> None:
        fields = {
            "status": "done" if ok else "failed",
            "result": result,
            "error": error,
            "finished_at": _now(),
        }
        self._update("doorway_jobs", job_id, fields)

    async def list_jobs(self, status: str | None = None, limit: int = 100) -> list[dict]:
        return self._list("doorway_jobs", newest_first=True, status=status)[:limit]

    async def requeue_stale(self, seconds: int = 60) -> int:
        cutoff = datetime.now(UTC) - timedelta(seconds=seconds)
        sandboxes = self.tables["doorway_sandboxes"]
        count = 0
        for job in self.tables["doorway_jobs"].values():
            sandbox = sandboxes.get(job["claimed_by"])
            if job["status"] != "running" or sandbox is None:
                continue
            if datetime.fromisoformat(sandbox["last_heartbeat"]) < cutoff:
                job.update(status="queued", claimed_by=None, started_at=None)
                count += 1
        return count

    # sandboxes + messages

    async def heartbeat(self, sandbox: dict) -> None:
        self._upsert("doorway_sandboxes", {**sandbox, "last_heartbeat": _now()}, ("id",))

    async def list_sandboxes(self) -> list[dict]:
        rows = sorted(self._rows("doorway_sandboxes"), key=lambda r: r["id"])
        return copy.deepcopy(rows)

    async def post_message(self, message: dict) -> dict:
        return self._insert("doorway_messages", message)

    async def list_messages(self, since: int = 0, to: str | None = None) -> list[dict]:
        rows = [
            r
            for r in self.tables["doorway_messages"].values()
            if to is None or r["to_sandbox"] in (None, to)
        ]
        return _since_slice(rows, since, MESSAGE_LIMIT)

    # runs, races, requests, events

    async def record_run(self, run: dict) -> dict:
        return self._insert("doorway_runs", run)

    async def list_runs(self, tool_id: int | None = None, limit: int = 50) -> list[dict]:
        return self._list("doorway_runs", newest_first=True, tool_id=tool_id)[:limit]

    async def create_race(self, race: dict) -> dict:
        return self._insert("doorway_races", race)

    async def update_race(self, race_id: str, fields: dict) -> None:
        self._update("doorway_races", race_id, {**fields, "updated_at": _now()})

    async def get_race(self, race_id: str) -> dict | None:
        return self._get("doorway_races", race_id)

    async def create_request(self, req: dict) -> dict:
        return self._insert("doorway_requests", req)

    async def update_request(self, request_id: str, fields: dict) -> None:
        self._update("doorway_requests", request_id, {**fields, "updated_at": _now()})

    async def get_request(self, request_id: str) -> dict | None:
        return self._get("doorway_requests", request_id)

    async def emit(
        self,
        site_id: str | None,
        kind: str,
        message: str,
        data: dict | None = None,
        sandbox_id: str | None = None,
    ) -> dict:
        row = {
            "site_id": site_id,
            "sandbox_id": sandbox_id,
            "kind": kind,
            "message": message,
            "data": data or {},
        }
        return self._insert("doorway_events", row)

    async def list_events(
        self, site_id: str | None = None, since: int = 0, limit: int = EVENT_LIMIT
    ) -> list[dict]:
        rows = [
            r
            for r in self.tables["doorway_events"].values()
            if site_id is None or r["site_id"] == site_id
        ]
        return _since_slice(rows, since, limit)

    # profiles + consent

    async def get_profile(self, user_id: str) -> dict:
        row = self.tables["doorway_profiles"].get(user_id)
        return {"fields": copy.deepcopy(row["fields"]) if row else {}}

    async def save_profile(self, user_id: str, fields: dict) -> dict:
        row = {"user_id": user_id, "fields": fields, "updated_at": _now()}
        saved = self._upsert("doorway_profiles", row, ("user_id",))
        return {"fields": saved["fields"]}

    async def list_consents(self, user_id: str) -> list[dict]:
        return self._list("doorway_consents", newest_first=True, user_id=user_id)

    async def grant_consent(self, user_id: str, site_id: str, fields: list[str]) -> dict:
        row = {"user_id": user_id, "site_id": site_id, "fields": fields, "granted_at": _now()}
        return self._upsert("doorway_consents", row, ("user_id", "site_id"))

    async def revoke_consent(self, user_id: str, consent_id: int) -> None:
        row = self.tables["doorway_consents"].get(consent_id)
        if row is not None and row["user_id"] == user_id:
            del self.tables["doorway_consents"][consent_id]


def _since_slice(rows: list[dict], since: int, limit: int) -> list[dict]:
    if since:
        picked = sorted((r for r in rows if r["id"] > since), key=lambda r: r["id"])
    else:
        picked = sorted(rows, key=lambda r: r["id"], reverse=True)
    return copy.deepcopy(picked[:limit])


@lru_cache
def _supabase_store() -> SupabaseStore:
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", settings.supabase_url or settings.supabase_rest_url),
            ("SUPABASE_SECRET_KEY", settings.supabase_secret_key),
        )
        if not value
    ]
    if missing:
        raise NotConfigured(*missing)
    rest_url = settings.supabase_rest_url or f"{settings.supabase_url.rstrip('/')}/rest/v1"
    return SupabaseStore(rest_url, settings.supabase_secret_key)


def get_doorway_store() -> DoorwayStore:
    """FastAPI dependency. Tests override it with MemoryStore."""
    return _supabase_store()


def doorway_store_cache_clear() -> None:
    _supabase_store.cache_clear()
