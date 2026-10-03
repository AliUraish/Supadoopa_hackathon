"""Tool specs: normalize, validate and fill them in. Specs are declarative recipes, never code.

Placeholders: "{{name}}" takes an input; a string that is only a placeholder keeps the value's
type. "{{from:<tool>:<dot.path>}}" (tests only) reuses an earlier tool's output. One filter
exists for ids that pack several values: "{{slot_id|split:-:0}}" is the first "-" part,
"{{slot_id|split:-:1:4}}" joins parts 1..3 with "-".

Form/browser "result": {"selector", "wait"?, "state"?, "many"?, "fields"?, "attr"?,
"error_selector"?}. Without "fields" the data is the element's text; "fields" maps keys to
"text", "@attr", "css" or "css@attr" so lists come back as structured rows. A step/field with
"missing_error" fails as an input error (not broken) when its element is absent.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import unquote, urlencode, urljoin, urlsplit

from .interfaces import STRATEGIES

NAME = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
PLACEHOLDER = re.compile(r"\{\{\s*([\w.:-]+)\s*((?:\|[^{}|]+)*)\}\}")
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
BLOCKED_HEADERS = {"host", "cookie", "authorization", "content-length"}
STEP_ACTIONS = {"goto", "click", "fill", "select", "wait", "check", "press"}
ABSOLUTE = re.compile(r"^[a-z][a-z0-9+.-]*:|^[/\\]{2}", re.I)


def get_path(value: Any, path: str | None) -> Any:
    if not path:
        return value
    for key in path.split("."):
        if (
            isinstance(value, list)
            and key.lstrip("-").isdigit()
            and -len(value) <= int(key) < len(value)
        ):
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict | list):
        return json.dumps(value)
    return str(value)


def _apply(value: Any, filters: str) -> Any:
    for f in filter(None, (part.strip() for part in filters.split("|"))):
        name, *args = f.split(":")
        if name != "split" or len(args) not in (2, 3):
            raise ValueError(f"unknown placeholder filter {f!r}")
        parts = _text(value).split(args[0] or " ")
        start = int(args[1])
        value = (args[0] or " ").join(parts[start : int(args[2])]) if len(args) == 3 else (
            parts[start] if -len(parts) <= start < len(parts) else ""
        )  # fmt: skip
    return value


def render(template: Any, lookup: Callable[[str], Any]) -> Any:
    """Fill placeholders in strings, lists and dicts (keys stay as they are)."""
    if isinstance(template, str):
        whole = PLACEHOLDER.fullmatch(template)
        if whole:
            return _apply(lookup(whole[1]), whole[2])
        return PLACEHOLDER.sub(lambda m: _text(_apply(lookup(m[1]), m[2])), template)
    if isinstance(template, list):
        return [render(t, lookup) for t in template]
    if isinstance(template, dict):
        return {k: render(v, lookup) for k, v in template.items()}
    return template


def placeholders(template: Any) -> set[str]:
    """Every placeholder key used anywhere in a template."""
    if isinstance(template, str):
        return {m[1] for m in PLACEHOLDER.finditer(template)}
    items = template.values() if isinstance(template, dict) else template
    if isinstance(template, dict | list):
        return set().union(*(placeholders(t) for t in items)) if items else set()
    return set()


def normalize(spec: dict) -> dict:
    """A copy in the current format: legacy top-level request/response become strategies.api."""
    spec = copy.deepcopy(spec)
    strategies = dict(spec.get("strategies") or {})
    if "request" in spec:
        legacy = {"request": spec.pop("request"), "response": spec.pop("response", None) or {}}
        strategies.setdefault("api", legacy)
    spec.pop("response", None)
    api = strategies.get("api")
    request = api.get("request") if isinstance(api, dict) else None
    if isinstance(request, dict) and isinstance(request.get("method"), str):
        request["method"] = request["method"].upper()
    spec["strategies"] = strategies
    if "kind" not in spec:
        spec["kind"] = (
            "read" if isinstance(request, dict) and request.get("method") == "GET" else "action"
        )
    if spec.get("preferred") not in strategies:
        spec["preferred"] = next((s for s in STRATEGIES if s in strategies), None)
    return spec


def available(spec: dict) -> list[str]:
    """Strategies the spec has, preferred first, then api, form, browser."""
    have = [s for s in STRATEGIES if s in (spec.get("strategies") or {})]
    preferred = spec.get("preferred")
    return ([preferred] if preferred in have else []) + [s for s in have if s != preferred]


def _relative(path: Any) -> bool:
    return isinstance(path, str) and not ABSOLUTE.match(path)


def _check_steps(where: str, steps: Any, errors: list[str]) -> None:
    if not isinstance(steps, list):
        errors.append(f"{where} must be a list")
        return
    for i, step in enumerate(steps):
        action = step.get("action", "fill") if isinstance(step, dict) else None
        if action not in STEP_ACTIONS:
            errors.append(f"{where}[{i}].action invalid")
        elif action == "goto":
            if not _relative(step.get("path", "")):
                errors.append(f"{where}[{i}].path must be relative")
        elif not (isinstance(step.get("selector"), str) and step["selector"]):
            if not (action == "wait" and isinstance(step.get("ms"), int)):
                errors.append(f"{where}[{i}].selector required")


def _check_result(where: str, result: Any, errors: list[str]) -> None:
    if not (
        isinstance(result, dict) and isinstance(result.get("selector"), str) and result["selector"]
    ):
        errors.append(f"{where}.result.selector required")


def validate(spec: dict) -> list[str]:
    """Problems that make a spec unsafe or unusable (empty list = fine). Accepts legacy specs."""
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    spec = normalize(spec)
    errors: list[str] = []
    if not NAME.match(str(spec.get("name") or "")):
        errors.append("name must be snake_case")
    if not spec.get("description"):
        errors.append("description required")
    if (spec.get("input_schema") or {}).get("type") != "object":
        errors.append("input_schema must be an object schema")
    if spec["kind"] not in ("read", "action"):
        errors.append("kind must be read or action")
    strategies = spec["strategies"]
    if unknown := set(strategies) - set(STRATEGIES):
        errors.append(f"unknown strategies: {', '.join(sorted(unknown))}")
    if not any(s in strategies for s in STRATEGIES):
        errors.append("at least one strategy (api, form, browser) required")

    if "api" in strategies:
        api = strategies["api"] if isinstance(strategies["api"], dict) else {}
        req = api.get("request") if isinstance(api.get("request"), dict) else {}
        if req.get("method") not in METHODS:
            errors.append("api.request.method invalid")
        if not _relative(req.get("path")):
            errors.append("api.request.path must be relative")
        for header in req.get("headers") or {}:
            if header.lower() in BLOCKED_HEADERS:
                errors.append(f"header {header} not allowed")
        select = (api.get("response") or {}).get("select")
        if select is not None and not isinstance(select, str):
            errors.append("api.response.select must be a dot path")
    if "form" in strategies:
        form = strategies["form"] if isinstance(strategies["form"], dict) else {}
        if not _relative(form.get("path", "")):
            errors.append("form.path must be relative")
        _check_steps("form.fields", form.get("fields", []), errors)
        if "submit" in form and not (isinstance(form["submit"], str) and form["submit"]):
            errors.append("form.submit must be a selector")
        _check_result("form", form.get("result"), errors)
    if "browser" in strategies:
        browser = strategies["browser"] if isinstance(strategies["browser"], dict) else {}
        if not browser.get("steps"):
            errors.append("browser.steps required")
        _check_steps("browser.steps", browser.get("steps"), errors)
        _check_result("browser", browser.get("result"), errors)
    if not isinstance((spec.get("test") or {}).get("input", {}), dict):
        errors.append("test.input must be an object")
    return errors


def resolve_url(base: str, path: str, query: dict | None = None) -> str:
    """Resolve a spec path against the site base; refuse anything outside it (SSRF guard)."""
    base = base if base.endswith("/") else f"{base}/"
    b = urlsplit(base)
    if b.scheme not in ("http", "https") or not b.hostname:
        raise ValueError(f"site base must be an http(s) URL, got {base}")
    if not isinstance(path, str):
        raise ValueError("path must be a string")
    url = urljoin(base, path.lstrip("/"))
    u = urlsplit(url)
    segments = unquote(u.path).replace("\\", "/").split("/")
    if (u.scheme, u.netloc) != (b.scheme, b.netloc) or not u.path.startswith(b.path) or (
        "." in segments or ".." in segments
    ):  # fmt: skip
        raise ValueError(f"refusing to call {url}: outside {base}")
    params = [(k, _text(v)) for k, v in (query or {}).items() if v is not None]
    if params:
        url = f"{url.split('#')[0]}{'&' if u.query else '?'}{urlencode(params)}"
    return url


def depends_on(spec: dict) -> list[str]:
    """Tool names a spec's test input pulls output from ({{from:<tool>:...}})."""
    keys = placeholders((spec.get("test") or {}).get("input") or {})
    return sorted({k.split(":")[1] for k in keys if k.startswith("from:")})


def resolve_test_inputs(spec: dict, outputs: dict[str, Any]) -> dict:
    """The spec's test input with {{from:<tool>:<dot.path>}} filled from earlier outputs."""

    def lookup(key: str) -> Any:
        kind, _, rest = key.partition(":")
        tool, _, path = rest.partition(":")
        if kind != "from" or not tool:
            raise ValueError(f"unknown test placeholder {key}")
        if tool not in outputs:
            raise ValueError(f"test depends on {tool}, which has no output")
        value = get_path(outputs[tool], path)
        if value is None:
            raise ValueError(f"{tool} output has nothing at {path!r}")
        return value

    return render((spec.get("test") or {}).get("input") or {}, lookup)
