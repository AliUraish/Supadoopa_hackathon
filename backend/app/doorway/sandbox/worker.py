"""A sandbox: claims jobs from the shared queue and runs them, heartbeating as it goes.

Lifecycle: heartbeat + `hello` message + sandbox.online event → loop {claim_job(kinds) →
run the handler under a timeout → finish_job} with a heartbeat every 5 s (idle/busy, the
current job, its site and kind, jobs done) and requeue_stale(60) every ~30 s, so jobs held
by a sandbox that died go back to the queue. On stop: offline heartbeat + sandbox.offline.
A job interrupted by shutdown is left running; requeue_stale hands it to another sandbox.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from ..interfaces import DoorwayStore
from . import jobs, liveview

log = logging.getLogger(__name__)

HEARTBEAT_S = 5.0
REQUEUE_S = 30.0
STALE_S = 60
# discover/heal may wait up to 10 min for a person to sign in (liveview.HUMAN_WAIT_S)
TIMEOUTS_S = {"discover": 900, "verify": 300, "heal": 900, "optimize": 600, "race": 240}
ALL_KINDS = tuple(TIMEOUTS_S)


class Worker:
    def __init__(
        self,
        sandbox_id: str,
        store: DoorwayStore,
        *,
        kinds: list[str] | None = None,
        poll: float = 1.0,
        heartbeat: float = HEARTBEAT_S,
        requeue: float = REQUEUE_S,
    ):
        self.id, self.store = sandbox_id, store
        self.kinds = list(kinds) if kinds else None
        self.poll, self.heartbeat_every, self.requeue_every = poll, heartbeat, requeue
        self.status = "idle"
        self.job: dict | None = None
        self.jobs_done = 0
        self.ctx = jobs.JobContext(store, sandbox_id)

    async def beat(self) -> None:
        job = self.job or {}
        await self.store.heartbeat(
            {
                "id": self.id,
                "status": self.status,
                "current_job_id": job.get("id"),
                "site_id": job.get("site_id"),
                "job_kind": job.get("kind"),
                "jobs_done": self.jobs_done,
            }
        )

    async def run(self, stop: asyncio.Event) -> None:
        await self.beat()
        await self.ctx.post("hello", {"kinds": self.kinds or list(ALL_KINDS)})
        await self.ctx.emit(
            None, "sandbox.online", f"{self.id} is online", {"kinds": self.kinds or list(ALL_KINDS)}
        )
        pulse = asyncio.create_task(self._pulse(stop))
        next_requeue = time.monotonic()
        try:
            while not stop.is_set():
                if time.monotonic() >= next_requeue:
                    next_requeue = time.monotonic() + self.requeue_every
                    await self._requeue()
                job = await self.store.claim_job(self.id, self.kinds)
                if job is None:
                    await _wait(stop, self.poll)
                    continue
                await self._run_job(job, stop)
        finally:
            pulse.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pulse
            self.status, self.job = "offline", None
            with contextlib.suppress(Exception):
                await self.beat()
                await self.ctx.emit(None, "sandbox.offline", f"{self.id} went offline")

    async def _pulse(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await _wait(stop, self.heartbeat_every)
            if stop.is_set():
                return
            try:
                await self.beat()
            except Exception:
                log.exception("%s heartbeat failed", self.id)

    async def _requeue(self) -> None:
        try:
            n = await self.store.requeue_stale(STALE_S)
            if n:
                log.info("%s requeued %d stale jobs", self.id, n)
        except Exception:
            log.exception("requeue_stale failed")

    async def _run_job(self, job: dict, stop: asyncio.Event) -> None:
        self.job, self.status = job, "busy"
        await self.beat()
        log.info(
            "%s running %s job %s (site %s)", self.id, job["kind"], job["id"], job.get("site_id")
        )
        liveview.JOBS[self.id] = {
            "kind": job["kind"],
            "job_id": job["id"],
            "site_id": job.get("site_id"),
        }
        token = liveview.current_sandbox.set(self.id)  # copied into the task's context
        task = asyncio.create_task(
            asyncio.wait_for(jobs.run(job, self.ctx), TIMEOUTS_S.get(job["kind"], 300))
        )
        liveview.current_sandbox.reset(token)
        stopping = asyncio.create_task(stop.wait())
        try:
            await asyncio.wait({task, stopping}, return_when=asyncio.FIRST_COMPLETED)
            if not task.done():  # shutting down: leave it for requeue_stale
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
                return
            ok, result, error = await _outcome(task)
            await self.store.finish_job(job["id"], ok=ok, result=result, error=error)
            self.jobs_done += 1
            log.info("%s finished %s job %s: %s", self.id, job["kind"], job["id"], error or "ok")
        finally:
            stopping.cancel()
            liveview.JOBS.pop(self.id, None)
            self.job, self.status = None, "idle"
            with contextlib.suppress(Exception):
                await self.beat()


async def _outcome(task: asyncio.Task) -> tuple[bool, dict | None, str | None]:
    try:
        return True, await task, None
    except jobs.JobFailed as exc:
        return False, exc.result or None, str(exc)[:500]
    except TimeoutError:
        return False, None, "timed out"
    except Exception as exc:
        log.exception("job crashed")
        return False, None, f"{type(exc).__name__}: {exc}"[:500]


async def _wait(stop: asyncio.Event, seconds: float) -> None:
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(stop.wait(), seconds)


async def run_workers(
    store: DoorwayStore,
    ids: list[str],
    *,
    kinds: list[str] | None = None,
    stop: asyncio.Event | None = None,
    **options: Any,
) -> None:
    """Run sandboxes concurrently in this process until `stop` is set."""
    stop = stop or asyncio.Event()
    workers = [Worker(i, store, kinds=kinds, **options) for i in ids]
    await asyncio.gather(*(w.run(stop) for w in workers))
