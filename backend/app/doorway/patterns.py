"""Shared memory: recognise reusable tool shapes (patterns) and adopt them on new sites.

A pattern is learned from one site's verified tools ("slot_booking": list resources → list
slots for a resource and day → book a slot with name + phone). Another sandbox exploring a
different site matches the same *shape* in what it captured and adopts the pattern's role
names, descriptions and input schemas, so agents see uniform tools across sites. Only the
per-site strategies (how to call that site) differ.

Mapping format (match → adopt): {role: {"tool": <site tool name>, "inputs": {role_input:
site_input}}}.
"""

from __future__ import annotations

import copy
import re
from typing import Any

FROM = re.compile(r"^\{\{\s*from:([a-z0-9_]+):([^}]*)\}\}$")
DATE_VALUE = re.compile(r"^\d{4}-\d{2}-\d{2}")

# A person's name ("owner_name", "full_name"), not a pet's or a product's ("pet_name").
_NAME = re.compile(
    r"^(name|full_?name|first_?name|last_?name|your_?name)$|(^|_)(patient|guest|customer|owner|"
    r"patron|borrower|client|contact|person|user|member|attendee|visitor)(_full)?_?name$"
)
_PHONE = re.compile(r"(phone|tel|mobile|cell)")
_EMAIL = re.compile(r"e_?mail")
_DATE = re.compile(r"(^|_)(date|day|when|on)(_|$)")
_QUERY = re.compile(r"^(q|query|search|term|keyword|keywords|text|title)$")
_MESSAGE = re.compile(r"(message|body|comment|notes?|question|details|inquiry|enquiry)")


def snake(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name))
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()
    if not s or not s[0].isalpha():
        s = f"x_{s}"
    return s[:63]


def input_kind(name: str, prop: dict | None = None, value: Any = None) -> str:
    """Semantic kind of a tool input: link|name|phone|email|date|query|message|other."""
    if isinstance(value, str) and FROM.match(value):
        return "link"
    n = snake(name)
    fmt = (prop or {}).get("format")
    if _EMAIL.search(n) or fmt == "email":
        return "email"
    if _PHONE.search(n):
        return "phone"
    if fmt == "date" or _DATE.search(n) or (isinstance(value, str) and DATE_VALUE.match(value)):
        return "date"
    if _NAME.search(n):
        return "name"
    if _QUERY.match(n):
        return "query"
    if _MESSAGE.search(n):
        return "message"
    return "other"


def links(spec: dict) -> dict[str, tuple[str, str]]:
    """{input: (producer_tool, path)} from the spec's test ({{from:tool:path}})."""
    out = {}
    for k, v in ((spec.get("test") or {}).get("input") or {}).items():
        m = FROM.match(v) if isinstance(v, str) else None
        if m:
            out[k] = (m.group(1), m.group(2))
    return out


def _inputs(spec: dict) -> dict[str, str]:
    """{input_name: kind} in schema order."""
    props = (spec.get("input_schema") or {}).get("properties") or {}
    tests = (spec.get("test") or {}).get("input") or {}
    return {k: input_kind(k, p, tests.get(k)) for k, p in props.items()}


def _required(spec: dict) -> list[str]:
    return list((spec.get("input_schema") or {}).get("required") or [])


def _first(kinds: dict[str, str], kind: str, exclude=()) -> str | None:
    return next((k for k, v in kinds.items() if v == kind and k not in exclude), None)


# --- role templates -----------------------------------------------------------------------

_S = {"type": "string"}
ROLE_INPUTS: dict[str, dict] = {
    "resource_id": {**_S, "description": "Resource id from list_resources"},
    "date": {**_S, "description": "Day as YYYY-MM-DD"},
    "slot_id": {**_S, "description": "Slot id from list_slots"},
    "item_id": {**_S, "description": "Item id from search_items"},
    "query": {**_S, "description": "Words to search for"},
    "name": {**_S, "description": "Full name of the person"},
    "phone": {**_S, "description": "Contact phone number"},
    "email": {**_S, "description": "Contact email address"},
    "message": {**_S, "description": "The message to send"},
}
PROFILE = {"name": "full_name", "phone": "phone", "email": "email"}

TEMPLATES: dict[str, dict] = {
    "slot_booking": {
        "description": "List resources → list open slots for a resource and day → book a slot "
        "with name + phone",
        "roles": {
            "list_resources": {
                "kind": "read",
                "description": "List the bookable resources here (for example doctors, tables, "
                "groomers or rooms) with their ids. Start here, then call list_slots.",
                "inputs": [],
                "required": [],
            },
            "list_slots": {
                "kind": "read",
                "description": "List open time slots for one resource on one day. Each slot has "
                "an id to pass to book_slot. Try the next day if the list is empty.",
                "inputs": ["resource_id", "date"],
                "required": ["resource_id", "date"],
            },
            "book_slot": {
                "kind": "action",
                "description": "Book one open slot (from list_slots) for a person. Returns the "
                "booking confirmation.",
                "inputs": ["slot_id", "name", "phone", "email"],
                "required": ["slot_id", "name", "phone", "email"],
            },
        },
    },
    "search_and_hold": {
        "description": "Search a catalog by keyword → place a hold on one item for a person",
        "roles": {
            "search_items": {
                "kind": "read",
                "description": "Search the catalog by keyword. Each result has an id to pass to "
                "hold_item.",
                "inputs": ["query"],
                "required": ["query"],
            },
            "hold_item": {
                "kind": "action",
                "description": "Place a hold (reservation) on one item from search_items for a "
                "person. Returns the confirmation.",
                "inputs": ["item_id", "name", "phone", "email"],
                "required": ["item_id", "name", "phone", "email"],
            },
        },
    },
    "contact_form": {
        "description": "Send a message to the business with name + contact details",
        "roles": {
            "submit_contact": {
                "kind": "action",
                "description": "Send a message to the business on behalf of a person. Returns "
                "the confirmation.",
                "inputs": ["name", "email", "phone", "message"],
                "required": ["name", "email", "phone", "message"],
            },
        },
    },
}


# --- detection ----------------------------------------------------------------------------


def _detect_slot_booking(specs: list[dict]) -> dict | None:
    by_name = {s["name"]: s for s in specs}
    for book in specs:
        if book.get("kind") != "action":
            continue
        kinds, lk = _inputs(book), links(book)
        name, phone, email = (_first(kinds, k) for k in ("name", "phone", "email"))
        if not name or not (phone or email):
            continue
        for slot_input, (slots_tool, _) in lk.items():
            slots = by_name.get(slots_tool)
            if not slots or slots.get("kind") != "read":
                continue
            s_kinds, s_links = _inputs(slots), links(slots)
            date = _first(s_kinds, "date")
            if not date:
                continue
            mapping = {
                "list_slots": {"tool": slots_tool, "inputs": {"date": date}},
                "book_slot": {
                    "tool": book["name"],
                    "inputs": {
                        k: v
                        for k, v in {
                            "slot_id": slot_input,
                            "name": name,
                            "phone": phone,
                            "email": email,
                        }.items()
                        if v
                    },
                },
            }
            for res_input, (res_tool, _) in s_links.items():
                res = by_name.get(res_tool)
                if res and res.get("kind") == "read" and not _required(res):
                    mapping["list_slots"]["inputs"]["resource_id"] = res_input
                    mapping["list_resources"] = {"tool": res_tool, "inputs": {}}
                    break
            return mapping
    return None


def _detect_search_and_hold(specs: list[dict]) -> dict | None:
    by_name = {s["name"]: s for s in specs}
    for hold in specs:
        if hold.get("kind") != "action":
            continue
        kinds = _inputs(hold)
        name = _first(kinds, "name")
        if not name:
            continue
        for item_input, (search_tool, _) in links(hold).items():
            search = by_name.get(search_tool)
            if not search or search.get("kind") != "read":
                continue
            query = _first(_inputs(search), "query")
            if not query:
                continue
            contact = {k: _first(kinds, k) for k in ("phone", "email")}
            return {
                "search_items": {"tool": search_tool, "inputs": {"query": query}},
                "hold_item": {
                    "tool": hold["name"],
                    "inputs": {
                        "item_id": item_input,
                        "name": name,
                        **{k: v for k, v in contact.items() if v},
                    },
                },
            }
    return None


def _detect_contact_form(specs: list[dict]) -> dict | None:
    for spec in specs:
        if spec.get("kind") != "action" or links(spec):
            continue
        kinds = _inputs(spec)
        roles = {k: _first(kinds, k) for k in ("name", "email", "phone", "message")}
        if roles["name"] and roles["message"] and (roles["email"] or roles["phone"]):
            return {
                "submit_contact": {
                    "tool": spec["name"],
                    "inputs": {k: v for k, v in roles.items() if v},
                }
            }
    return None


DETECTORS = {
    "slot_booking": _detect_slot_booking,
    "search_and_hold": _detect_search_and_hold,
    "contact_form": _detect_contact_form,
}


def detect_all(specs: list[dict]) -> list[tuple[str, dict]]:
    """Every known pattern these specs have, each on its own tools: [(name, mapping)]."""
    found, used = [], set()
    for name, fn in DETECTORS.items():
        mapping = fn([s for s in specs if s["name"] not in used])
        if mapping:
            found.append((name, mapping))
            used.update(m["tool"] for m in mapping.values())
    return found


def detect(specs: list[dict]) -> tuple[str, dict] | None:
    """First known pattern whose shape these specs have: (pattern_name, mapping)."""
    found = detect_all(specs)
    return found[0] if found else None


def _role_spec(pattern_name: str, role: str) -> dict:
    t = TEMPLATES[pattern_name]["roles"][role]
    props = {k: ROLE_INPUTS[k] for k in t["inputs"]}
    return {
        "name": role,
        "description": t["description"],
        "kind": t["kind"],
        "input_schema": {"type": "object", "properties": props, "required": t["required"]},
        "profile_fields": {k: v for k, v in PROFILE.items() if k in props},
    }


def derive_pattern(site_id: str, specs: list[dict]) -> dict | None:
    """A pattern row (for store.create_pattern) if these verified specs have a known shape."""
    rows = derive_patterns(site_id, specs)
    return rows[0] if rows else None


def derive_patterns(site_id: str, specs: list[dict]) -> list[dict]:
    """A pattern row for every known shape in these verified specs."""
    return [_pattern_row(site_id, name, mapping) for name, mapping in detect_all(specs)]


def _pattern_row(site_id: str, name: str, mapping: dict) -> dict:
    roles = {role: _role_spec(name, role) for role in mapping}
    signature = {
        "pattern": name,
        "roles": {
            role: {"kind": roles[role]["kind"], "inputs": sorted(m["inputs"])}
            for role, m in mapping.items()
        },
        "example": {role: m["tool"] for role, m in mapping.items()},
    }
    return {
        "name": name,
        "description": TEMPLATES[name]["description"],
        "signature": signature,
        "template": {"roles": roles, "signature": signature},
        "source_site_id": site_id,
    }


def match(pattern: dict, specs: list[dict]) -> dict | None:
    """Role mapping if `specs` (freshly compiled from captured calls) have the pattern's shape.

    The mapping must cover every role the pattern was learned with.
    """
    name = pattern.get("name")
    fn = DETECTORS.get(name)
    if not fn:
        return None
    mapping = fn(specs)
    wanted = set(((pattern.get("template") or {}).get("roles") or {}).keys())
    if not mapping or not wanted.issubset(mapping):
        return None
    return mapping


# --- renaming -----------------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{\{\s*([\w.:-]+)\s*((?:\|[^{}|]+)*)\}\}")  # keeps |filters


def _rewrite(value: Any, fn) -> Any:
    if isinstance(value, str):
        return _PLACEHOLDER.sub(lambda m: "{{" + fn(m.group(1)) + m.group(2) + "}}", value)
    if isinstance(value, list):
        return [_rewrite(v, fn) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite(v, fn) for k, v in value.items()}
    return value


def rename_inputs(spec: dict, renames: dict[str, str]) -> dict:
    """A copy with input placeholders (strategies/legacy request) and test keys renamed."""
    spec = copy.deepcopy(spec)
    for key in ("strategies", "request"):
        if key in spec:
            spec[key] = _rewrite(spec[key], lambda k: renames.get(k, k))
    test = spec.get("test") or {}
    if isinstance(test.get("input"), dict):
        test["input"] = {renames.get(k, k): v for k, v in test["input"].items()}
    if isinstance(spec.get("profile_fields"), dict):
        spec["profile_fields"] = {renames.get(k, k): v for k, v in spec["profile_fields"].items()}
    return spec


def rename_tools(specs: list[dict], renames: dict[str, str]) -> list[dict]:
    """Rename tools and every {{from:<tool>:...}} reference to them."""

    def fix(key: str) -> str:
        parts = key.split(":", 2)
        if len(parts) == 3 and parts[0] == "from" and parts[1] in renames:
            return f"from:{renames[parts[1]]}:{parts[2]}"
        return key

    out = []
    for spec in specs:
        spec = copy.deepcopy(spec)
        spec["name"] = renames.get(spec["name"], spec["name"])
        for key in ("undo", "undoes"):  # write <-> undo pairs follow renames too
            if spec.get(key) in renames:
                spec[key] = renames[spec[key]]
        if spec.get("test"):
            spec["test"] = _rewrite(spec["test"], fix)
        out.append(spec)
    return out


def adopt(pattern: dict, mapping: dict, site_specs: list[dict]) -> list[dict]:
    """Site specs with mapped tools renamed to the pattern's roles (names, descriptions, input
    schemas); per-site strategies are kept. Unmapped tools pass through (references fixed)."""
    roles = (pattern.get("template") or {}).get("roles") or {}
    by_tool = {m["tool"]: (role, m["inputs"]) for role, m in mapping.items()}
    out = []
    for spec in site_specs:
        if spec["name"] not in by_tool:
            out.append(spec)
            continue
        role, inputs = by_tool[spec["name"]]
        template = roles.get(role) or _role_spec(pattern["name"], role)
        renamed = rename_inputs(spec, {site: r for r, site in inputs.items()})
        site_schema = spec.get("input_schema") or {}
        site_props = site_schema.get("properties") or {}
        mapped_site = set(inputs.values())
        t_props = (template.get("input_schema") or {}).get("properties") or {}
        t_req = (template.get("input_schema") or {}).get("required") or []
        props = {r: t_props.get(r, ROLE_INPUTS.get(r, _S)) for r in inputs}
        required = [r for r in inputs if r in t_req]
        for k, p in site_props.items():  # extras the role doesn't know about
            if k not in mapped_site:
                props[k] = p
                if k in (site_schema.get("required") or []):
                    required.append(k)
        renamed.update(
            name=role,
            description=template.get("description", spec.get("description")),
            kind=template.get("kind", spec.get("kind")),
            input_schema={"type": "object", "properties": props, "required": required},
            profile_fields={
                **{k: v for k, v in (renamed.get("profile_fields") or {}).items() if k in props},
                **{k: v for k, v in (template.get("profile_fields") or {}).items() if k in props},
            },
        )
        out.append(renamed)
    return rename_tools(out, {tool: role for tool, (role, _) in by_tool.items()})
