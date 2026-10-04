"""One shared headless Chromium per event loop; every run gets its own fresh context.

Playwright objects belong to the event loop that created them, so the browser is kept per
loop (tests and TestClient each run their own). Tasks on the same loop share it safely.
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from dataclasses import dataclass, field
from typing import Any

from playwright.async_api import Browser, BrowserContext, async_playwright

from . import sessions

LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"]
# Called with every new context (the sandbox live view tags them with their sandbox).
CONTEXT_HOOKS: list = []


@dataclass
class _Shared:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    playwright: Any = None
    browser: Browser | None = None


_by_loop: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _Shared] = (
    weakref.WeakKeyDictionary()
)


def _shared() -> _Shared:
    loop = asyncio.get_running_loop()
    if loop not in _by_loop:
        _by_loop[loop] = _Shared()
    return _by_loop[loop]


async def get_browser() -> Browser:
    """The process's headless Chromium (launched on first use, relaunched if it died)."""
    shared = _shared()
    async with shared.lock:
        if shared.browser is None or not shared.browser.is_connected():
            if shared.playwright is None:
                shared.playwright = await async_playwright().start()
            shared.browser = await shared.playwright.chromium.launch(
                headless=True, args=LAUNCH_ARGS
            )
        return shared.browser


async def new_context(**options: Any) -> BrowserContext:
    """A fresh isolated context (no cookies/storage shared with other runs). Close it after."""
    saved = sessions.CURRENT.get()  # a saved sign-in for this run: start signed in
    if saved and "storage_state" not in options:
        options["storage_state"] = saved
    context = await (await get_browser()).new_context(**options)
    for hook in CONTEXT_HOOKS:
        with contextlib.suppress(Exception):
            hook(context)
    return context


async def close_browser() -> None:
    shared = _by_loop.pop(asyncio.get_running_loop(), None)
    if shared is None:
        return
    async with shared.lock:
        with contextlib.suppress(Exception):  # already gone is fine
            if shared.browser is not None:
                await shared.browser.close()
        with contextlib.suppress(Exception):
            if shared.playwright is not None:
                await shared.playwright.stop()
