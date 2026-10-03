"""Demo websites Doorway explores: human pages over private, version-switchable JSON APIs.

Run them with `uv run python -m demo_sites --all` (from backend/). The Sunrise clinic is the
Node original in supabase/compute/clinic; registry.py lists all four for Doorway.
"""

from __future__ import annotations

import importlib

from fastapi import FastAPI

# site id -> (module, default port)
SITES = {
    "bella-bistro": ("demo_sites.bella_bistro", 4101),
    "pawsome-vet": ("demo_sites.pawsome_vet", 4102),
    "city-library": ("demo_sites.city_library", 4103),
}


def create_app(site_id: str) -> FastAPI:
    """A fresh app (with fresh in-memory state) for one demo site."""
    return importlib.import_module(SITES[site_id][0]).create_app()
