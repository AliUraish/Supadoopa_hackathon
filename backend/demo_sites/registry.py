"""The four demo sites Doorway knows about, and `seed(store)` to register them.

Base URLs default to localhost (4100-4103) and can be overridden with CLINIC_URL, BISTRO_URL,
VET_URL and LIBRARY_URL (a trailing "/" is added: pages use relative fetches).
"""

from __future__ import annotations

import os

_SITES = [
    ("sunrise-clinic", "Sunrise Family Clinic", "CLINIC_URL", 4100, "Book a doctor's appointment"),
    ("bella-bistro", "Bella Bistro", "BISTRO_URL", 4101, "Reserve a table for dinner"),
    ("pawsome-vet", "Pawsome Vet", "VET_URL", 4102, "Book a vet appointment for a pet"),
    ("city-library", "City Library", "LIBRARY_URL", 4103, "Place a hold on a library book"),
]


def demo_sites() -> list[dict]:
    """The demo site rows, with base URLs read from the environment now."""
    sites = []
    for site_id, name, env, port, goal in _SITES:
        url = os.environ.get(env) or f"http://localhost:{port}/"
        sites.append({"id": site_id, "name": name, "base_url": url.rstrip("/") + "/",
                      "goal": goal, "is_demo": True})  # fmt: skip
    return sites


DEMO_SITES = demo_sites()


async def seed(store) -> list[dict]:
    """Upsert every demo site into a DoorwayStore (see app/doorway/interfaces.py)."""
    return [await store.upsert_site(site) for site in demo_sites()]
