"""Run tool specs against a live site. Implements interfaces.Executor as module functions.

Strategies: api (replay the site's private JSON call with httpx), form (open a page, fill one
form, submit, read the result element), browser (replay a recorded click path, read result).

ExecResult.broken: True = the tool no longer matches the site and needs healing (endpoint
404/405/410/3xx, non-JSON, response.select missing, a selector never appeared). False = the
caller's input or a business rule (missing input, slot taken, other 4xx/5xx, the page's own
error message) or the site being unreachable.

execute(strategy=None) runs spec["preferred"], then the other strategies (api, form, browser),
moving on only when a strategy is broken. After a successful fallback, result.strategy differs
from spec["preferred"] and result.error lists what the skipped strategies said.
"""

from __future__ import annotations

import contextlib
import json
import re
import ssl
import statistics
import time
from collections.abc import Awaitable, Callable
from functools import cache
from typing import Any

import certifi
import httpx
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout

from . import browser as browser_mod
from . import sessions
from .interfaces import STRATEGIES, ExecResult, Strategy, VerifyResult
from .spec import (
    BLOCKED_HEADERS,
    available,
    depends_on,
    get_path,
    normalize,
    render,
    resolve_test_inputs,
    resolve_url,
    validate,
)

API_TIMEOUT_S = 20
ACTION_TIMEOUT_MS = 8_000
NAV_TIMEOUT_MS = 15_000
MISSING_WAIT_MS = 1_500
SETTLE_MS = 3_000  # bounded networkidle wait before reading a page result
MANY_WAIT_MS = 3_000  # bounded wait for a list's first row after its wait element shows
OVERFIT_ERROR = "only works for the example input (hard-coded value)"
FIRST_ITEM = re.compile(r"(\{\{\s*from:([^:{}]+):)0(?=[.\s|}])")
BROKEN_STATUSES = {404, 405, 410}
NON_BLANK = re.compile(r"\S")

# Fixed extraction code (specs only pass data): how = None | "css@attr" | {key: "text"|...}.
EXTRACT = """(el, how) => {
  const text = (n) => (n.innerText || n.textContent || '').trim();
  const read = (node, f) => {
    if (f === 'text') return text(node);
    const at = f.lastIndexOf('@');
    const sel = at >= 0 ? f.slice(0, at) : f;
    const target = sel ? node.querySelector(sel) : node;
    if (!target) return null;
    return at >= 0 ? target.getAttribute(f.slice(at + 1)) : text(target);
  };
  if (!how) return text(el);
  if (typeof how === 'string') return read(el, how);
  return Object.fromEntries(Object.entries(how).map(([k, f]) => [k, read(el, f)]));
}"""
EXTRACT_ALL = f"(els, how) => els.map((el) => ({EXTRACT})(el, how))"


class _Failure(Exception):
    def __init__(self, error: str, *, broken: bool, status: int = 0):
        super().__init__(error)
        self.error, self.broken, self.status = error, broken, status


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _text(value: Any) -> str:
    return "" if value is None else value if isinstance(value, str) else json.dumps(value)


def _first_line(exc: Exception) -> str:
    return (str(exc).strip().splitlines() or [type(exc).__name__])[0]


def _preview(data: Any) -> str:
    text = data if isinstance(data, str) else json.dumps(data, default=str)
    return text if len(text) <= 300 else f"{text[:300]}…"


@cache
def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=certifi.where())


# --- api ----------------------------------------------------------------------------


async def _run_api(spec: dict, inputs: dict, base_url: str, _browser: Any) -> ExecResult:
    api = spec["strategies"]["api"]
    req = api.get("request") or {}
    method = req.get("method", "GET")
    try:
        path = render(req.get("path", ""), inputs.get)
        url = resolve_url(base_url, path, render(req.get("query") or {}, inputs.get))
        headers = httpx.Headers({"accept": "application/json"})
        for key, value in render(req.get("headers") or {}, inputs.get).items():
            if key.lower() not in BLOCKED_HEADERS:
                headers[key] = value if isinstance(value, str) else _text(value)
        body = req.get("body")
        body = render(body, inputs.get) if body is not None and method != "GET" else None
        # A saved sign-in for this run (never part of the spec): send its cookies.
        if cookie := sessions.cookie_header(sessions.CURRENT.get(), url):
            headers["cookie"] = cookie
    except (ValueError, TypeError) as exc:
        return ExecResult(ok=False, strategy="api", error=str(exc), broken=True, steps=0)

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(
            timeout=API_TIMEOUT_S, follow_redirects=False, verify=_ssl_context()
        ) as client:
            res = await client.request(method, url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        error = f"request failed: {_first_line(exc) if str(exc) else type(exc).__name__}"
        return ExecResult(ok=False, strategy="api", error=error, ms=_ms(started))
    ms, status = _ms(started), res.status_code
    try:
        data = res.json() if res.content else None
    except ValueError:
        error = f"response is not JSON (HTTP {status})"
        return ExecResult(ok=False, strategy="api", error=error, status=status, ms=ms, broken=True)
    error = _text(data.get("error")) if isinstance(data, dict) and data.get("error") else None
    error = error or f"HTTP {status}"
    if status in BROKEN_STATUSES or 300 <= status < 400:
        return ExecResult(ok=False, strategy="api", error=error, status=status, ms=ms, broken=True)
    if status >= 400:
        return ExecResult(ok=False, strategy="api", data=data, error=error, status=status, ms=ms)
    select = (api.get("response") or {}).get("select")
    selected = get_path(data, select)
    if select and selected is None:
        error = f'response no longer has "{select}"'
        return ExecResult(ok=False, strategy="api", error=error, status=status, ms=ms, broken=True)
    return ExecResult(ok=True, strategy="api", data=selected, status=status, ms=ms)


# --- form + browser -----------------------------------------------------------------


def _css_lookup(inputs: dict) -> Callable[[str], Any]:
    """Inputs rendered into selectors are escaped for use inside quoted attribute values."""
    return lambda key: _text(inputs.get(key)).replace("\\", "\\\\").replace('"', '\\"')


async def _step(page: Any, step: dict, inputs: dict, base_url: str) -> None:
    action = step.get("action", "fill")
    if action == "goto":
        url = resolve_url(base_url, render(step.get("path", ""), inputs.get))
        try:
            res = await page.goto(url, wait_until="domcontentloaded")
        except PlaywrightError as exc:
            raise _Failure(f"could not open {url}: {_first_line(exc)}", broken=False) from exc
        if res is not None and res.status >= 400:
            error = f"{url} returned HTTP {res.status}"
            raise _Failure(error, broken=res.status in BROKEN_STATUSES, status=res.status)
        return
    if action == "wait" and not step.get("selector"):
        await page.wait_for_timeout(min(int(step.get("ms") or 0), 10_000))
        return
    target = page.locator(render(step["selector"], _css_lookup(inputs))).first
    if step.get("missing_error"):
        try:
            await target.wait_for(state="attached", timeout=MISSING_WAIT_MS)
        except PlaywrightTimeout as exc:
            error = _text(render(step["missing_error"], inputs.get))
            raise _Failure(error, broken=False) from exc
    value = render(step.get("value"), inputs.get)
    value = value if isinstance(value, str) else _text(value)
    if action == "click":
        await target.click()
    elif action == "fill":
        await target.fill(value)
    elif action == "select":
        await target.select_option(value)
    elif action == "check":
        await target.check()
    elif action == "press":
        await target.press(value or "Enter")
    elif action == "wait":
        await target.wait_for(state=step.get("state", "visible"))
    else:
        raise _Failure(f"unknown step action {action!r}", broken=True)


async def _read(page: Any, result: dict, inputs: dict) -> Any:
    css = _css_lookup(inputs)
    how = result.get("fields") or (f"@{result['attr']}" if result.get("attr") else None)
    state = result.get("state", "attached")
    if result.get("wait"):
        await page.locator(render(result["wait"], css)).first.wait_for(state="visible")
    found = page.locator(render(result["selector"], css))
    ready = found if how or result.get("many") else found.filter(has_text=NON_BLANK)
    error = (
        page.locator(render(result["error_selector"], css))
        if result.get("error_selector")
        else None
    )
    first = (ready.or_(error) if error else ready).first
    if not (result.get("many") and result.get("wait")):
        await first.wait_for(state=state)
    else:  # a waited-for list may be empty, but rows can render after the wait element
        with contextlib.suppress(PlaywrightTimeout):
            await first.wait_for(state="attached", timeout=MANY_WAIT_MS)
    if error and await error.count():
        message = (await error.first.inner_text()).strip()
        raise _Failure(message or "the site reported an error", broken=False)
    if result.get("many"):
        return await found.evaluate_all(EXTRACT_ALL, how)
    return await ready.first.evaluate(EXTRACT, how)


async def _run_page(
    name: Strategy, steps: list[dict], result: dict, inputs: dict, base_url: str, browser: Any
) -> ExecResult:
    try:
        browser = browser or await browser_mod.get_browser()  # launch time isn't run time
        started, done, current = time.perf_counter(), 0, "open page"
        context = await browser.new_context()
    except PlaywrightError as exc:  # infrastructure, not the site: don't mark the tool broken
        return ExecResult(ok=False, strategy=name, error=f"browser unavailable: {exc}", steps=0)
    try:
        context.set_default_timeout(ACTION_TIMEOUT_MS)
        context.set_default_navigation_timeout(NAV_TIMEOUT_MS)
        page = await context.new_page()
        for step in steps:
            current = f"{step.get('action', 'fill')} {step.get('selector') or step.get('path', '')}"
            await _step(page, step, inputs, base_url)
            done += 1
        with contextlib.suppress(PlaywrightTimeout, PlaywrightError):  # let XHR results land
            await page.wait_for_load_state("networkidle", timeout=SETTLE_MS)
        current = f"read {result.get('selector')}"
        data = await _read(page, result, inputs)
        return ExecResult(ok=True, strategy=name, data=data, ms=_ms(started), steps=done)
    except _Failure as f:
        return ExecResult(
            ok=False, strategy=name, error=f.error, status=f.status, broken=f.broken,
            ms=_ms(started), steps=done,
        )  # fmt: skip
    except PlaywrightTimeout:
        error = f"{current.strip()}: element did not appear"
        return ExecResult(
            ok=False, strategy=name, error=error, broken=True, ms=_ms(started), steps=done
        )
    except (PlaywrightError, ValueError, TypeError, KeyError) as exc:
        error = f"{current.strip()}: {_first_line(exc)}"
        return ExecResult(
            ok=False, strategy=name, error=error, broken=True, ms=_ms(started), steps=done
        )
    finally:
        with contextlib.suppress(PlaywrightError):
            await context.close()


async def _run_form(spec: dict, inputs: dict, base_url: str, browser: Any) -> ExecResult:
    form = spec["strategies"]["form"]
    steps = [{"action": "goto", "path": form.get("path", "")}, *(form.get("fields") or [])]
    if form.get("submit"):
        steps.append({"action": "click", "selector": form["submit"]})
    return await _run_page("form", steps, form["result"], inputs, base_url, browser)


async def _run_browser(spec: dict, inputs: dict, base_url: str, browser: Any) -> ExecResult:
    flow = spec["strategies"]["browser"]
    steps = list(flow.get("steps") or [])
    if not steps or steps[0].get("action") != "goto":
        steps.insert(0, {"action": "goto", "path": ""})
    return await _run_page("browser", steps, flow["result"], inputs, base_url, browser)


RUNNERS = {"api": _run_api, "form": _run_form, "browser": _run_browser}


# --- Executor protocol --------------------------------------------------------------


async def execute(
    spec: dict,
    inputs: dict,
    base_url: str,
    *,
    strategy: Strategy | None = None,
    browser: Any = None,
) -> ExecResult:
    spec = normalize(spec)
    inputs = dict(inputs or {})
    required = (spec.get("input_schema") or {}).get("required") or []
    if missing := [k for k in required if inputs.get(k) is None or inputs.get(k) == ""]:
        error = f"missing input: {', '.join(missing)}"
        return ExecResult(ok=False, strategy=strategy or spec["preferred"], error=error, steps=0)
    if strategy is not None and strategy not in spec["strategies"]:
        return ExecResult(ok=False, strategy=strategy, error=f"tool has no {strategy} strategy")
    if errors := validate(spec):
        error = f"invalid spec: {'; '.join(errors)}"
        return ExecResult(ok=False, strategy=strategy, error=error, broken=True, steps=0)

    failures: list[str] = []
    for name in [strategy] if strategy else available(spec):
        result = await RUNNERS[name](spec, inputs, base_url, browser)
        if result.ok or not result.broken:
            if result.ok and failures:
                result.error = f"{'; '.join(failures)} (fell back to {name})"
            return result
        failures.append(f"{name}: {result.error}")
    if len(failures) > 1:
        result.error = "; ".join(failures)
    return result


async def verify(
    specs: list[dict], base_url: str, *, browser: Any = None, strategies=STRATEGIES
) -> list[VerifyResult]:
    """Run each spec's test, in order, once per available strategy.

    Tests may use earlier outputs ({{from:<tool>:<path>}}). Action tests consume what they
    use (a booked slot), so after each action run the tools it drew from are re-run for
    fresh values before the next strategy tries.
    """
    specs = [normalize(s) for s in specs]
    by_name = {s.get("name"): s for s in specs}
    outputs: dict[str, Any] = {}
    producers: dict[str, tuple[dict, Strategy]] = {}  # name -> inputs + strategy that passed
    stale: set[str] = set()
    results: list[VerifyResult] = []

    async def refresh(dep: str) -> None:
        dep_inputs, dep_strategy = producers[dep]
        r = await execute(
            by_name[dep], dep_inputs, base_url, strategy=dep_strategy, browser=browser
        )
        if not r.ok:  # e.g. the preferred strategy broke since: take any that works
            r = await execute(by_name[dep], dep_inputs, base_url, browser=browser)
        if r.ok:
            outputs[dep] = r.data
            stale.discard(dep)

    for spec in specs:
        name = str(spec.get("name") or "?")
        if errors := validate(spec):
            results.append(VerifyResult(name=name, passed=False, error="; ".join(errors)))
            continue
        runs: dict[str, tuple[ExecResult, dict]] = {}
        for strat in [s for s in available(spec) if s in strategies]:
            deps = depends_on(spec)
            for dep in deps:
                if dep in stale and dep in producers:
                    await refresh(dep)
            try:
                inputs = resolve_test_inputs(spec, outputs)
            except ValueError as exc:
                runs[strat] = (ExecResult(ok=False, strategy=strat, error=str(exc)), {})
                continue
            runs[strat] = (
                await execute(spec, inputs, base_url, strategy=strat, browser=browser),
                inputs,
            )
            if spec["kind"] == "action":
                stale.update(deps)

        if "api" in runs and runs["api"][0].ok:  # page strategies must not be overfit
            for strat in [s for s in ("form", "browser") if s in runs and runs[s][0].ok]:
                for dep in depends_on(spec):
                    if dep in stale and dep in producers:
                        await refresh(dep)
                if (second := _second_item_inputs(spec, outputs)) is None:
                    break  # no index-0 binding, or the producer returned < 2 items
                r = await execute(spec, second, base_url, strategy=strat, browser=browser)
                if spec["kind"] == "action":
                    stale.update(depends_on(spec))
                if not r.ok:
                    first, used = runs[strat]
                    runs[strat] = (
                        ExecResult(ok=False, strategy=strat, error=OVERFIT_ERROR, ms=first.ms),
                        used,
                    )

        passing = [s for s, (r, _) in runs.items() if r.ok]
        pick = spec["preferred"] if spec["preferred"] in passing else next(iter(passing), None)
        by_strategy = {
            s: {"passed": r.ok, "ms": r.ms, "error": None if r.ok else r.error, "broken": r.broken}
            for s, (r, _) in runs.items()
        }
        if pick is None:
            error = "; ".join(f"{s}: {r.error}" for s, (r, _) in runs.items())
            results.append(
                VerifyResult(
                    name=name,
                    passed=False,
                    error=error or "no strategy to verify",
                    by_strategy=by_strategy,
                )  # fmt: skip
            )
            continue
        best, used = runs[pick]
        outputs[name], producers[name] = best.data, (used, pick)
        results.append(
            VerifyResult(
                name=name,
                passed=True,
                strategy=pick,
                ms=best.ms,
                status=best.status,
                sample=_preview(best.data),
                by_strategy=by_strategy,
            )  # fmt: skip
        )
    return results


def _second_item_inputs(spec: dict, outputs: dict[str, Any]) -> dict | None:
    """The test input re-bound from item 0 to item 1 of each producer's list, or None when
    the test has no {{from:<tool>:0...}} binding or a producer returned fewer than 2 items."""
    raw = json.dumps((spec.get("test") or {}).get("input") or {})
    second = FIRST_ITEM.sub(r"\g<1>1", raw)
    if second == raw:
        return None
    for tool in {m.group(2) for m in FIRST_ITEM.finditer(raw)}:
        if not isinstance(outputs.get(tool), list) or len(outputs[tool]) < 2:
            return None
    try:
        return resolve_test_inputs({"test": {"input": json.loads(second)}}, outputs)
    except ValueError:
        return None


async def benchmark(
    spec: dict,
    inputs: dict,
    base_url: str,
    *,
    browser: Any = None,
    runs: int = 3,
    inputs_factory: Callable[[], Awaitable[dict]] | None = None,
    strategies=STRATEGIES,
) -> dict[str, dict]:
    """Time each strategy: {"api": {"passed", "p50_ms", "runs", "error"}, ...}.

    Action tools should pass inputs_factory (async, returns fresh inputs) so each run books
    something new; otherwise every run reuses `inputs`.
    """
    spec = normalize(spec)
    report: dict[str, dict] = {}
    for strat in [s for s in STRATEGIES if s in spec["strategies"] and s in strategies]:
        if strat != "api" and browser is None:
            await browser_mod.get_browser()  # launch outside the timings
        results = []
        for _ in range(max(1, runs)):
            run_inputs = await inputs_factory() if inputs_factory else inputs
            results.append(
                await execute(spec, run_inputs, base_url, strategy=strat, browser=browser)
            )
        ok = [r for r in results if r.ok]
        report[strat] = {
            "passed": len(ok) == len(results),
            "p50_ms": int(statistics.median(r.ms for r in ok or results)),
            "runs": len(results),
            "error": next((r.error for r in results if not r.ok), None),
        }
    return report
