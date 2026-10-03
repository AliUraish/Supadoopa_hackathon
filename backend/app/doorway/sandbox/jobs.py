"""Job handlers: discover, verify, heal, optimize, race.

Sandboxes cooperate only through the store: the job queue (claim_job never hands a verify
job to the sandbox that compiled the tools: not_sandbox), the message board (hello,
tool_published, need_tool, validated, pattern_published, broken) and shared patterns.

Every step emits a live event. Events and messages carry tool and input NAMES only, never
input values (they can be personal details).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from .. import executor, explorer
from .. import patterns as pat
from ..interfaces import JOB_PRIORITY, STRATEGIES, DoorwayStore, ExecResult, VerifyResult
from ..spec import available, depends_on, normalize, resolve_test_inputs
from . import broker_agent, browser_agent

log = logging.getLogger(__name__)

MAX_DISCOVER_ATTEMPTS = 3
ACTION_PRICE_CENTS = 50
DAY_RETRIES = 7  # producers that list nothing for a day: try the following days


@dataclass
class JobContext:
    store: DoorwayStore
    sandbox_id: str

    async def emit(self, site_id: str | None, kind: str, message: str, data: dict | None = None):
        await self.store.emit(site_id, kind, message, data or {}, sandbox_id=self.sandbox_id)

    async def post(self, kind: str, body: dict, to: str | None = None) -> None:
        await self.store.post_message(
            {"from_sandbox": self.sandbox_id, "to_sandbox": to, "kind": kind, "body": body}
        )

    def on_event(self, site_id: str):
        return lambda kind, message, data=None: self.emit(site_id, kind, message, data)


class JobFailed(Exception):
    """The job ran but did not succeed; `result` is stored with it."""

    def __init__(self, error: str, result: dict | None = None):
        super().__init__(error)
        self.result = result or {}


async def run(job: dict, ctx: JobContext) -> dict:
    handler = HANDLERS.get(job["kind"])
    if handler is None:
        raise JobFailed(f"unknown job kind {job['kind']!r}")
    return await handler(job, ctx)


async def _site(ctx: JobContext, job: dict) -> dict:
    site = await ctx.store.get_site(job.get("site_id") or "")
    if site is None:
        raise JobFailed(f"site {job.get('site_id')!r} not found")
    return site


# --- dates and fresh inputs -----------------------------------------------------------------


def _shift_dates(specs: list[dict], days: int) -> list[dict]:
    """Literal test dates moved to at least tomorrow (+days): tests must stay in the future."""
    floor = date.today() + timedelta(days=1)
    out = copy.deepcopy(specs)
    for spec in out:
        test = (spec.get("test") or {}).get("input") or {}
        for key, value in test.items():
            if isinstance(value, str) and pat.input_kind(key, None, value) == "date":
                try:
                    day = date.fromisoformat(value[:10])
                except ValueError:
                    continue
                test[key] = (max(day, floor) + timedelta(days=days)).isoformat() + value[10:]
    return out


def _empty_producer(results: list[VerifyResult]) -> bool:
    return any("has nothing at" in (r.error or "") for r in results if not r.passed)


def side_effect(spec: dict) -> str:
    """read | reversible_write | irreversible_write (specs without one: by kind)."""
    default = "read" if spec.get("kind") == "read" else "irreversible_write"
    return spec.get("side_effect") or default


async def verify_specs(
    specs: list[dict],
    base_url: str,
    *,
    allow_irreversible: bool = False,
    browser: Any = None,
    strategies=STRATEGIES,
) -> tuple[list[VerifyResult], list[dict], list[str]]:
    """Verify safely: reads run; a reversible write runs only paired with its undo (so the
    site ends where it started); irreversible writes run only when allowed (demo sites) and
    are otherwise held for a human. Test dates move forward while a listing comes back empty
    (a fully booked day is not a broken tool). Returns (results, specs as tested, held)."""
    results, trial, held = [], specs, []
    for days in range(DAY_RETRIES):
        trial = _shift_dates(specs, days)
        results, held = await _verify_safely(
            trial, base_url, allow_irreversible, browser, strategies
        )
        if all(r.passed for r in results) or not _empty_producer(results):
            break
    return results, trial, held


async def _verify_safely(specs, base_url, allow_irreversible, browser, strategies):
    specs = [normalize(s) for s in specs]
    by = {s["name"]: s for s in specs}
    pairs = [
        (s, by[s["undo"]])
        for s in specs
        if side_effect(s) == "reversible_write" and s.get("undo") in by
    ]
    undos = {u["name"] for _, u in pairs}
    plain, held = [], []
    for s in specs:
        if s["name"] in undos or any(w is s for w, _ in pairs):
            continue
        if side_effect(s) == "read" or allow_irreversible:
            plain.append(s)
        else:
            held.append(s["name"])
    results = await executor.verify(plain, base_url, browser=browser, strategies=strategies)
    for write, undo in pairs:
        results += await _verify_pair(write, undo, specs, base_url, strategies)
    order = {s["name"]: i for i, s in enumerate(specs)}
    return sorted(results, key=lambda r: order.get(r.name, 0)), held


async def _verify_pair(write: dict, undo: dict, specs, base_url, strategies) -> list[VerifyResult]:
    """Each strategy of `write` runs once and is immediately undone; a failed undo stops."""
    runs: dict[str, ExecResult] = {}
    undone: list[ExecResult] = []
    for strat in [s for s in available(write) if s in strategies]:
        try:
            inputs = await fresh_inputs(specs, write, base_url)
        except RuntimeError as exc:
            runs[strat] = ExecResult(ok=False, strategy=strat, error=str(exc))
            continue
        runs[strat] = r = await executor.execute(write, inputs, base_url, strategy=strat)
        if not r.ok:
            continue
        try:
            u = await executor.execute(
                undo, resolve_test_inputs(undo, {write["name"]: r.data}), base_url
            )
        except ValueError as exc:
            u = ExecResult(ok=False, error=f"undo: {exc}")
        undone.append(u)
        if not u.ok:
            break  # never write again while the undo is broken
    undo_ok = bool(undone) and all(u.ok for u in undone)
    passing = [s for s, r in runs.items() if r.ok] if undo_ok else []
    pick = write["preferred"] if write["preferred"] in passing else next(iter(passing), None)
    by_strategy = {
        s: {"passed": r.ok and undo_ok, "ms": r.ms, "error": r.error, "broken": r.broken}
        for s, r in runs.items()
    }
    error = (
        None
        if pick
        else "; ".join(
            [f"{s}: {r.error}" for s, r in runs.items() if not r.ok]
            + [u.error or "undo failed" for u in undone if not u.ok]
        )
    )
    best = runs.get(pick) if pick else None
    return [
        VerifyResult(
            name=write["name"],
            passed=pick is not None,
            strategy=pick,
            ms=best.ms if best else 0,
            error=error,
            by_strategy=by_strategy,
        ),
        VerifyResult(
            name=undo["name"],
            passed=undo_ok,
            strategy=undone[0].strategy if undone else None,
            ms=undone[0].ms if undone else 0,
            error=None if undo_ok else f"undo of {write['name']} did not pass",
            by_strategy={undone[0].strategy or "api": {"passed": undo_ok, "ms": undone[0].ms}}
            if undone
            else {},
        ),
    ]


async def fresh_inputs(specs: list[dict], target: dict, base_url: str) -> dict:
    """Inputs for `target` built from live producer outputs (so actions get an unused slot)."""
    wanted, queue = set(), list(depends_on(target))
    while queue:
        name = queue.pop()
        if name not in wanted:
            wanted.add(name)
            queue.extend(depends_on(next((s for s in specs if s["name"] == name), {})))
    last_error = "no producer output"
    for days in range(DAY_RETRIES):
        trial = {s["name"]: s for s in _shift_dates([*specs, target], days)}
        outputs: dict[str, Any] = {}
        try:
            for spec in specs:
                if spec["name"] in wanted:
                    r = await executor.execute(
                        trial[spec["name"]],
                        resolve_test_inputs(trial[spec["name"]], outputs),
                        base_url,
                    )
                    if not r.ok:
                        raise ValueError(f"{spec['name']}: {r.error}")
                    outputs[spec["name"]] = r.data
            target_trial = _shift_dates([target], days)[0]
            return resolve_test_inputs(target_trial, outputs)
        except ValueError as exc:
            last_error = str(exc)
    raise RuntimeError(f"no fresh inputs for {target['name']}: {last_error}")


def _strategies(result: VerifyResult) -> dict:
    return {
        s: {"passed": v.get("passed"), "ms": v.get("ms")} for s, v in result.by_strategy.items()
    }


def _summary(result: VerifyResult) -> str:
    if not result.passed:
        return f"{result.name} failed: {result.error}"
    parts = ", ".join(
        f"{s} {v.get('ms')} ms" if v.get("passed") else f"{s} ✗"
        for s, v in result.by_strategy.items()
    )
    return f"{result.name} passed ({parts})"


async def _hold(ctx: JobContext, site: dict, held: list[str]) -> None:
    """Irreversible writes on real sites are never auto-run: they wait for a person."""
    for name in held:
        reason = "needs human approval (irreversible)"
        await ctx.emit(
            site["id"],
            "verify.fail",
            f"{name}: {reason}",
            {"tool": name, "reason": "irreversible", "held": True},
        )
        await ctx.post("need_tool", {"site_id": site["id"], "tool": name, "reason": reason})


async def _emit_results(ctx: JobContext, site_id: str, results: list[VerifyResult]) -> None:
    for r in results:
        await ctx.emit(
            site_id,
            "verify.pass" if r.passed else "verify.fail",
            _summary(r),
            {
                "tool": r.name,
                "strategy": r.strategy,
                "ms": r.ms,
                "error": r.error,
                "strategies": _strategies(r),
            },
        )


async def _publish(
    ctx: JobContext,
    site: dict,
    specs: list[dict],
    results: list[VerifyResult],
    *,
    source: str,
    pattern_roles: dict[str, int] | None = None,
) -> list[dict]:
    """publish_version for every verified spec; returns the published tool rows."""
    store, published = ctx.store, []
    by_name = {r.name: r for r in results}
    caps = {c["name"]: c for c in await store.list_capabilities(site["id"])}
    for spec in specs:
        r = by_name.get(spec["name"])
        if r is None or not r.passed:
            continue
        spec = normalize(spec)
        tool = await store.find_tool(site["id"], spec["name"]) or await store.upsert_tool(
            _tool_row(site, spec, caps, (pattern_roles or {}).get(spec["name"]))
        )
        version = await store.publish_version(
            tool["id"], spec, source=source, verified_by=ctx.sandbox_id, strategies=_strategies(r)
        )
        stats = {"price_cents": _price(spec), "best_strategy": r.strategy}
        if (pattern_roles or {}).get(spec["name"]):
            stats["pattern_id"] = pattern_roles[spec["name"]]
        await store.update_tool_stats(tool["id"], stats)
        if spec["name"] in caps:
            await store.upsert_capability({**_cap_row(site, spec, caps), "status": "verified"})
        await ctx.emit(
            site["id"],
            "publish.tool",
            f"Published {spec['name']} v{version['version']} ({source}, verified by "
            f"{ctx.sandbox_id})",
            {
                "tool": spec["name"],
                "tool_id": tool["id"],
                "version": version["version"],
                "source": source,
            },
        )
        published.append({**tool, "version": version["version"]})
    return published


def _price(spec: dict) -> int:
    return ACTION_PRICE_CENTS if spec.get("kind") == "action" else 0


def _cap_row(site: dict, spec: dict, caps: dict) -> dict:
    old = caps.get(spec["name"]) or {}
    return {
        "site_id": site["id"],
        "name": spec["name"],
        "description": spec.get("description") or old.get("description") or spec["name"],
        "kind": spec.get("kind") or old.get("kind") or "read",
        "evidence": old.get("evidence") or {},
    }


def _tool_row(site: dict, spec: dict, caps: dict, pattern_id: int | None) -> dict:
    row = {
        "site_id": site["id"],
        "name": spec["name"],
        "description": spec["description"],
        "kind": spec["kind"],
        "status": "draft",
        "spec": spec,
        "price_cents": _price(spec),
        "pattern_id": pattern_id,
    }
    if spec["name"] in caps:
        row["capability_id"] = caps[spec["name"]]["id"]
    return row


async def _verified_specs(store: DoorwayStore, site_id: str) -> list[dict]:
    return [t["spec"] for t in await store.list_tools(site_id) if t.get("spec")]


# --- discover ---------------------------------------------------------------------------------


async def discover(job: dict, ctx: JobContext) -> dict:
    store, site = ctx.store, await _site(ctx, job)
    payload = job.get("payload") or {}
    attempt = int(payload.get("attempt") or 1)
    await store.set_site_status(site["id"], "discovering")
    await ctx.emit(
        site["id"],
        "discover.start",
        f"{ctx.sandbox_id} is exploring {site['name']} (attempt {attempt})",
        {"attempt": attempt, "goal": payload.get("goal") or site.get("goal")},
    )
    existing = await store.list_tools(site["id"])
    previous = [t["spec"] for t in existing if t["status"] == "verified" and t.get("spec")]
    try:
        result = await explorer.discover(
            {**site, "goal": payload.get("goal") or site.get("goal")},
            store=store,
            sandbox_id=ctx.sandbox_id,
            patterns=await store.list_patterns(),
            previous=previous or None,
            on_event=ctx.on_event(site["id"]),
        )
    except explorer.NeedHuman as exc:  # login wall / CAPTCHA / 2FA: no point retrying
        await ctx.emit(site["id"], "explore.action", f"Needs a human: {exc}", {"need_human": True})
        await ctx.post("need_tool", {"site_id": site["id"], "reason": f"need_human: {exc}"})
        await store.set_site_status(site["id"], "failed")
        raise JobFailed(f"need_human: {exc}") from exc
    except Exception as exc:
        await ctx.emit(site["id"], "explore.action", f"Exploration failed: {exc}")
        await _retry_or_fail(ctx, site, attempt, str(exc))
        raise JobFailed(f"exploration failed: {exc}") from exc

    caps = {}
    for cap in result["capabilities"]:
        row = await store.upsert_capability(
            {
                "site_id": site["id"],
                "name": cap["name"],
                "description": cap["description"],
                "kind": cap["kind"],
                "status": "compiled",
                "evidence": cap.get("evidence") or {},
            }
        )
        caps[cap["name"]] = row
        await ctx.emit(
            site["id"],
            "observe.capability",
            f"Found capability {cap['name']} ({cap['kind']})",
            {"capability": cap["name"], "kind": cap["kind"], "evidence": cap.get("evidence")},
        )

    pattern_id = result.get("pattern_id")
    pattern_roles = result.get("pattern_roles") or {}
    names = []
    for spec in result["tools"]:
        spec = normalize(spec)
        names.append(spec["name"])
        tool = await store.find_tool(site["id"], spec["name"])
        if tool is None or tool["status"] != "verified":  # live tools change only once verified
            await store.upsert_tool(_tool_row(site, spec, caps, pattern_roles.get(spec["name"])))
        await ctx.emit(
            site["id"],
            "compile.tool",
            f"Compiled {spec['name']} ({spec['kind']}; {', '.join(spec['strategies'])})",
            {
                "tool": spec["name"],
                "kind": spec["kind"],
                "strategies": list(spec["strategies"]),
                "inputs": list((spec.get("input_schema") or {}).get("properties") or {}),
            },
        )
    await ctx.post(
        "tool_published",
        {"site_id": site["id"], "tools": names, "status": "draft", "pattern_id": pattern_id},
    )
    verify_job = await store.enqueue_job(
        {
            "kind": "verify",
            "site_id": site["id"],
            "priority": JOB_PRIORITY["verify"],
            "not_sandbox": ctx.sandbox_id,  # independent verification on another sandbox
            "payload": {
                "source": "reuse" if pattern_id else "discover",
                "attempt": attempt,
                "pattern_id": pattern_id,
                "pattern_roles": pattern_roles,
                "compiled_by": ctx.sandbox_id,
                "specs": result["tools"],
            },
        }
    )
    return {
        "tools": names,
        "pattern_id": pattern_id,
        "explorer": result.get("explorer"),
        "verify_job_id": verify_job["id"],
    }


async def _retry_or_fail(ctx: JobContext, site: dict, attempt: int, reason: str) -> None:
    if attempt < MAX_DISCOVER_ATTEMPTS:
        await ctx.store.set_site_status(site["id"], "queued")
        await ctx.store.enqueue_job(
            {
                "kind": "discover",
                "site_id": site["id"],
                "priority": JOB_PRIORITY["discover"],
                "payload": {"attempt": attempt + 1, "reason": reason[:300]},
            }
        )
    else:
        await ctx.store.set_site_status(site["id"], "failed")


# --- verify -----------------------------------------------------------------------------------


async def verify(job: dict, ctx: JobContext) -> dict:
    store, site = ctx.store, await _site(ctx, job)
    payload = job.get("payload") or {}
    specs = payload.get("specs") or await _verified_specs(store, site["id"])
    compiled_by = payload.get("compiled_by")
    await store.set_site_status(site["id"], "verifying")
    await ctx.emit(
        site["id"],
        "verify.start",
        f"{ctx.sandbox_id} is independently verifying {len(specs)} tools"
        + (f" compiled by {compiled_by}" if compiled_by else ""),
        {"tools": [s.get("name") for s in specs], "compiled_by": compiled_by},
    )
    results, specs, held = await verify_specs(
        specs, site["base_url"], allow_irreversible=bool(site.get("is_demo"))
    )
    await _emit_results(ctx, site["id"], results)
    await _hold(ctx, site, held)
    pattern_roles = {k: v for k, v in (payload.get("pattern_roles") or {}).items() if v}
    used_patterns = sorted(set(pattern_roles.values()))
    names = [r.name for r in results]

    failed = [r.name for r in results if not r.passed]
    if failed or not (results or held):
        await ctx.post(
            "need_tool",
            {
                "site_id": site["id"],
                "failed": failed,
                "errors": {r.name: (r.error or "")[:200] for r in results if not r.passed},
            },
        )
        for pid in used_patterns:
            await store.pattern_used(pid, site["id"], False)
        attempt = int(payload.get("attempt") or 1)
        await _retry_or_fail(ctx, site, attempt, f"verification failed: {', '.join(failed)}")
        raise JobFailed(
            f"verification failed: {', '.join(failed) or 'no tools'}", {"failed": failed}
        )

    await _publish(
        ctx,
        site,
        specs,
        results,
        source=payload.get("source") or "discover",
        pattern_roles=pattern_roles,
    )
    await store.set_site_status(site["id"], "ready")
    await ctx.post(
        "validated",
        {
            "site_id": site["id"],
            "tools": names,
            "verified_by": ctx.sandbox_id,
            "compiled_by": compiled_by,
        },
    )
    for pid in used_patterns:
        await store.pattern_used(pid, site["id"], True)
    created = await _share_patterns(ctx, site, specs)
    await store.enqueue_job(
        {"kind": "optimize", "site_id": site["id"], "priority": JOB_PRIORITY["optimize"]}
    )
    return {"verified": names, "patterns_used": used_patterns, "patterns_created": created}


async def _share_patterns(ctx: JobContext, site: dict, specs: list[dict]) -> list[int]:
    """Learn reusable patterns from this site's verified tools and tell the other sandboxes.
    Shapes already in the shared memory (e.g. the one this site adopted) are skipped."""
    known = {p["name"] for p in await ctx.store.list_patterns()}
    created = []
    for derived in pat.derive_patterns(site["id"], specs):
        if derived["name"] in known:
            continue
        row = await ctx.store.create_pattern({**derived, "created_by": ctx.sandbox_id})
        roles = list(derived["template"]["roles"])
        await ctx.post(
            "pattern_published",
            {"pattern_id": row["id"], "name": row["name"], "site_id": site["id"], "roles": roles},
        )
        await ctx.emit(
            site["id"],
            "publish.tool",
            f"Shared pattern {row['name']} with every sandbox ({', '.join(roles)})",
            {"pattern_id": row["id"], "pattern": row["name"]},
        )
        created.append(row["id"])
    return created


# --- optimize ---------------------------------------------------------------------------------


async def optimize(job: dict, ctx: JobContext) -> dict:
    store, site = ctx.store, await _site(ctx, job)
    tools = [
        t for t in await store.list_tools(site["id"]) if t["status"] == "verified" and t["spec"]
    ]
    specs = [normalize(t["spec"]) for t in tools]
    report = {}
    for tool, spec in zip(tools, specs, strict=True):
        if side_effect(spec) != "read" and not site.get("is_demo"):
            await ctx.emit(
                site["id"],
                "optimize.result",
                f"{spec['name']}: not benchmarked (writes are only repeated on demo sites)",
                {"tool": spec["name"], "skipped": "write"},
            )
            continue
        try:
            if spec["kind"] == "action":
                bench = await executor.benchmark(
                    spec,
                    {},
                    site["base_url"],
                    runs=2,
                    inputs_factory=lambda spec=spec: fresh_inputs(specs, spec, site["base_url"]),
                )
            else:
                inputs = await fresh_inputs(specs, spec, site["base_url"])
                bench = await executor.benchmark(spec, inputs, site["base_url"], runs=3)
        except Exception as exc:
            log.warning("benchmark of %s failed: %s", spec["name"], exc)
            await ctx.emit(
                site["id"], "optimize.result", f"{spec['name']}: benchmark failed ({exc})"
            )
            continue
        passed = {s: v for s, v in bench.items() if v.get("passed")}
        best = min(passed, key=lambda s: passed[s]["p50_ms"]) if passed else None
        report[spec["name"]] = {"best": best, "strategies": bench}
        if best:
            await store.update_tool_stats(
                tool["id"], {"best_strategy": best, "p50_ms": passed[best]["p50_ms"]}
            )
            if spec.get("preferred") != best:
                await store.upsert_tool(
                    {
                        "site_id": site["id"],
                        "name": tool["name"],
                        "description": tool["description"],
                        "kind": tool["kind"],
                        "spec": {**spec, "preferred": best},
                    }
                )
        timings = " · ".join(
            f"{s} {v['p50_ms']} ms" if v.get("passed") else f"{s} ✗" for s, v in bench.items()
        )
        await ctx.emit(
            site["id"],
            "optimize.result",
            f"{spec['name']}: {timings} → prefer {best or 'nothing (all failed)'}",
            {"tool": spec["name"], "best": best, "strategies": bench},
        )
    return {"tools": report}


# --- heal -------------------------------------------------------------------------------------


async def heal(job: dict, ctx: JobContext) -> dict:
    store = ctx.store
    payload = job.get("payload") or {}
    tool = await store.get_tool(int(payload.get("tool_id") or job.get("tool_id") or 0))
    if tool is None:
        raise JobFailed("tool to heal not found")
    site = await store.get_site(tool["site_id"])
    if site is None:
        raise JobFailed(f"site {tool['site_id']!r} not found")
    error = str(payload.get("error") or "the tool stopped working")[:300]
    started = time.monotonic()
    await store.set_tool_status(tool["id"], "repairing")
    await store.set_site_status(site["id"], "healing")
    await ctx.post(
        "broken",
        {"site_id": site["id"], "tool_id": tool["id"], "tool": tool["name"], "error": error},
    )
    await ctx.emit(
        site["id"],
        "heal.start",
        f"{ctx.sandbox_id} is re-exploring the site to repair {tool['name']}",
        {"by": ctx.sandbox_id, "tool": tool["name"], "tool_id": tool["id"], "error": error},
    )
    try:
        previous = await _verified_specs(store, site["id"])
        result = await explorer.discover(
            site,
            store=store,
            sandbox_id=ctx.sandbox_id,
            patterns=[],
            previous=previous,
            broken={"tool": tool["name"], "error": error},
            on_event=ctx.on_event(site["id"]),
        )
        specs = [s for s in result["tools"] if s["name"] in {p["name"] for p in previous}]
        if tool["name"] not in {s["name"] for s in specs}:
            raise RuntimeError(f"{tool['name']} no longer exists on the site")
        await ctx.emit(site["id"], "verify.start", f"Verifying {len(specs)} repaired tools")
        results, specs, held = await verify_specs(
            specs, site["base_url"], allow_irreversible=bool(site.get("is_demo"))
        )
        await _emit_results(ctx, site["id"], results)
        await _hold(ctx, site, held)
        if tool["name"] in held:
            raise RuntimeError("the repaired tool is irreversible and needs human approval")
        if not all(r.passed for r in results):
            failed = ", ".join(r.name for r in results if not r.passed)
            raise RuntimeError(f"repaired tools failed verification: {failed}")
        published = await _publish(ctx, site, specs, results, source="heal")
    except Exception as exc:
        await store.set_tool_status(tool["id"], "broken")
        await store.set_site_status(site["id"], "broken")
        await ctx.emit(
            site["id"],
            "heal.fail",
            f"{ctx.sandbox_id} could not repair {tool['name']}: {exc}",
            {"by": ctx.sandbox_id, "tool": tool["name"], "tool_id": tool["id"]},
        )
        raise JobFailed(f"heal failed: {exc}") from exc

    await store.set_site_status(site["id"], "ready")
    seconds = round(time.monotonic() - started, 1)
    version = next((t["version"] for t in published if t["id"] == tool["id"]), None)
    await ctx.post(
        "validated",
        {
            "site_id": site["id"],
            "tools": [t["name"] for t in published],
            "verified_by": ctx.sandbox_id,
            "healed": tool["name"],
        },
    )
    await ctx.emit(
        site["id"],
        "heal.done",
        f"{ctx.sandbox_id} repaired {tool['name']} (v{version}) in {seconds} s; "
        "same name and inputs",
        {
            "by": ctx.sandbox_id,
            "tool": tool["name"],
            "tool_id": tool["id"],
            "version": version,
            "seconds": seconds,
        },
    )
    return {"healed": tool["name"], "version": version, "tools": [t["name"] for t in published]}


# --- race -------------------------------------------------------------------------------------


async def race(job: dict, ctx: JobContext) -> dict:
    store = ctx.store
    race_id = (job.get("payload") or {}).get("race_id")
    current = await store.get_race(race_id) if race_id else None
    if current is None:
        raise JobFailed(f"race {race_id!r} not found")
    site = await store.get_site(current["site_id"] or job.get("site_id") or "")
    if site is None:
        await store.update_race(race_id, {"status": "failed"})
        raise JobFailed("race site not found")
    tools = [
        t for t in await store.list_tools(site["id"]) if t["status"] == "verified" and t["spec"]
    ]
    running = {"status": "running", "ms": 0, "steps": 0, "tokens": 0, "success": None, "log": []}
    await store.update_race(race_id, {"status": "running", "browser": running, "broker": running})
    lock = asyncio.Lock()

    async def update(side: str, state: dict) -> None:
        async with lock:
            await store.update_race(race_id, {side: state})

    # The race row is public and holds input names only; values live in the private request.
    request = await store.get_request(race_id)
    inputs = {
        k: v
        for k, v in ((request or {}).get("inputs") or {}).items()
        if v not in (None, "", "[private]")
    }
    task = current["task"]
    browser_res, broker_res = await asyncio.gather(
        _side(browser_agent.run, "browser", site, task, tools, inputs, update, race_id),
        _side(broker_agent.run, "broker", site, task, tools, inputs, update, race_id),
    )
    ok = broker_res.get("success") or browser_res.get("success")
    await store.update_race(
        race_id,
        {"status": "done" if ok else "failed", "browser": browser_res, "broker": broker_res},
    )
    for mode, res in (("browser_agent", browser_res), ("broker", broker_res)):
        await store.record_run(
            {
                "tool_id": res.get("tool_id"),
                "site_id": site["id"],
                "mode": mode,
                "strategy": res.get("strategy"),
                "status": "success" if res.get("success") else "failure",
                "ms": res.get("ms"),
                "steps": res.get("steps"),
                "tokens": res.get("tokens"),
                "error": res.get("error"),
            }
        )
    await ctx.emit(
        site["id"],
        "execute.call",
        f"Race: broker {broker_res.get('ms')} ms / {broker_res.get('steps')} steps vs browser "
        f"agent {browser_res.get('ms')} ms / {browser_res.get('steps')} steps",
        {
            "race_id": race_id,
            "broker_ms": broker_res.get("ms"),
            "browser_ms": browser_res.get("ms"),
        },
    )
    return {
        "race_id": race_id,
        "broker_ms": broker_res.get("ms"),
        "browser_ms": browser_res.get("ms"),
    }


async def _side(fn, side, site, task, tools, inputs, update, race_id) -> dict:
    started = time.perf_counter()
    try:
        res = await fn(
            site, task, tools, inputs=inputs, on_update=lambda s: update(side, s), race_id=race_id
        )
    except Exception as exc:
        log.exception("%s agent crashed", side)
        res = {
            "success": False,
            "error": f"{type(exc).__name__}: {exc}"[:300],
            "log": [],
            "steps": 0,
        }
    res.setdefault("ms", int((time.perf_counter() - started) * 1000))
    res.setdefault("tokens", 0)
    res["status"] = "done" if res.get("success") else "failed"
    return res


HANDLERS = {
    "discover": discover,
    "verify": verify,
    "heal": heal,
    "optimize": optimize,
    "race": race,
}
