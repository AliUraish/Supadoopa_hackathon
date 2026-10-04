"use client";

// Interactive sign-in: the sandbox stopped at a login wall, so the user drives its browser.
// Clicks, keys and the "type into the page" box go straight to the site's own form;
// Doorway never stores the password, only the resulting session.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import Link from "next/link";
import { describeError, DoorwayError } from "@/lib/doorway";
import { useNow } from "@/lib/doorway/live";
import { takeover, type Claim, type TakeoverInput } from "@/lib/doorway/takeover";
import { Icon } from "@/components/px/icons";
import { Banner, Button, Input, Loading } from "@/components/px/ui";
import type { ComputeSandbox } from "./compute";

const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

export function TakeoverDialog({
  liveUrl,
  sandbox,
  onClose,
}: {
  liveUrl: string;
  sandbox: ComputeSandbox;
  onClose: () => void;
}) {
  const now = useNow();
  const need = sandbox.needs_human;
  const [mode, setMode] = useState<"stream" | "poll">("stream");
  const [tick, setTick] = useState(0);
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState<"done" | "cancel" | "release" | null>(null);
  const [claim, setClaim] = useState<{ ok: Claim } | { err: unknown } | null>(null);
  const token = claim && "ok" in claim ? claim.ok.control_token : null;
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Claim the sandbox first: the control token unlocks its screen and keyboard for this user only.
  useEffect(() => {
    let cancelled = false;
    takeover.claim(liveUrl, sandbox.sandbox).then(
      (ok) => {
        if (!cancelled) setClaim({ ok });
      },
      (err: unknown) => {
        if (!cancelled) setClaim({ err });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [liveUrl, sandbox.sandbox]);
  const lastWheel = useRef(0);

  // Fallback when the MJPEG stream isn't available: poll single frames quickly.
  useEffect(() => {
    if (mode !== "poll") return;
    const timer = setInterval(() => setTick((t) => t + 1), 300);
    return () => clearInterval(timer);
  }, [mode]);

  // Inputs are sent one after another so keystrokes keep their order.
  const send = (input: TakeoverInput) => {
    if (!token) return;
    queue.current = queue.current
      .then(() => takeover.input(liveUrl, sandbox.sandbox, token, input))
      .catch((err: unknown) => setError(err));
  };

  const onClick = (e: MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const vp = (claim && "ok" in claim ? claim.ok.viewport : null) ?? sandbox.viewport;
    const vw = vp?.width ?? img.naturalWidth;
    const vh = vp?.height ?? img.naturalHeight;
    if (!vw || !vh) return;
    send({
      type: "click",
      x: Math.round(((e.clientX - rect.left) / rect.width) * vw),
      y: Math.round(((e.clientY - rect.top) / rect.height) * vh),
    });
    img.parentElement?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey) return; // let paste etc. through
    if (e.key.length === 1) send({ type: "type", text: e.key });
    else if (SPECIAL_KEYS.has(e.key)) send({ type: "key", key: e.key });
    else return;
    e.preventDefault();
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const t = e.timeStamp;
    if (t - lastWheel.current < 120) return;
    lastWheel.current = t;
    send({ type: "scroll", dy: Math.round(e.deltaY) });
  };

  const sendSecret = (thenEnter: boolean) => {
    if (!secret) return;
    send({ type: "type", text: secret });
    if (thenEnter) send({ type: "key", key: "Enter" });
    setSecret("");
  };

  const finish = (kind: "done" | "cancel" | "release") => {
    if (!token) return;
    setFinishing(kind);
    setError(null);
    takeover[kind](liveUrl, sandbox.sandbox, token).then(
      () => onClose(),
      (err: unknown) => {
        setError(err);
        setFinishing(null);
      },
    );
  };

  const expiresIn = need?.expires_at && now ? Math.max(0, Math.round((Date.parse(need.expires_at) - now) / 1000)) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Sign in through the sandbox">
      <div className="px-panel flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden shadow-2xl shadow-black/60">
        <header className="flex items-start gap-3 border-b border-line px-5 py-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-amber/40 bg-amber/10 text-amber">
            <Icon name="lock" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-text">
              {need
                ? `Sign in to ${need.site_id ?? sandbox.job?.site_id ?? "the site"}`
                : `Take over ${sandbox.sandbox}`}
            </h2>
            <p className="truncate text-xs text-muted">
              {need
                ? `${sandbox.sandbox} stopped at ${need.reason ?? "a login wall"}`
                : `${sandbox.job?.kind ?? "job"} on ${sandbox.job?.site_id ?? "a site"} · the sandbox pauses while you drive`}
              {(need?.page_url ?? sandbox.url) && <> · <span className="font-mono">{need?.page_url ?? sandbox.url}</span></>}
              {expiresIn !== null && <> · {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, "0")} left</>}
            </p>
          </div>
          <Button size="sm" variant="ghost" icon="close" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {!claim ? (
            <Loading label="Taking control of the sandbox" />
          ) : "err" in claim ? (
            <ClaimError error={claim.err} />
          ) : (
          <div
            tabIndex={0}
            onKeyDown={onKeyDown}
            onWheel={onWheel}
            className="relative overflow-hidden rounded-md border border-line-2 bg-black outline-none focus:border-green"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- live screen of the sandbox's browser */}
            <img
              src={
                mode === "stream"
                  ? takeover.streamUrl(liveUrl, sandbox.sandbox, claim.ok.control_token)
                  : takeover.frameUrl(liveUrl, sandbox.sandbox, claim.ok.control_token, tick)
              }
              alt={`Live browser of ${sandbox.sandbox}`}
              className="block h-auto w-full cursor-pointer select-none"
              draggable={false}
              onClick={onClick}
              onError={() => setMode("poll")}
            />
          </div>
          )}
          <p className="text-xs text-faint">
            Click the screen to focus a field, then type. Scroll works too. Use the box below for passwords.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[260px] flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Type into the selected field</span>
              <div className="relative">
                <Input
                  type={reveal ? "text" : "password"}
                  value={secret}
                  autoComplete="off"
                  placeholder="Email, password or code"
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      sendSecret(true);
                    }
                  }}
                  className="pr-16"
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-text"
                >
                  {reveal ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <Button variant="ghost" onClick={() => sendSecret(false)} disabled={!secret}>
              Send
            </Button>
            <Button onClick={() => sendSecret(true)} disabled={!secret}>
              Send + Enter
            </Button>
            <div className="flex gap-1">
              {["Tab", "Enter", "Backspace"].map((k) => (
                <Button key={k} size="sm" variant="ghost" onClick={() => send({ type: "key", key: k })}>
                  {k}
                </Button>
              ))}
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-faint">
            <Icon name="lock" size={12} />
            Typed straight into the site&apos;s own form in the sandbox. Doorway never stores your password, only the
            signed-in session, encrypted and used only for your tool calls.
          </p>

          {error !== null && (
            <Banner tone="bad" title="The sandbox didn't accept that">
              {describeError(error)}
            </Banner>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <Button variant="danger" onClick={() => finish("cancel")} loading={finishing === "cancel"} disabled={finishing !== null || !token}>
            Cancel sign-in
          </Button>
          {!need && (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => finish("release")}
              loading={finishing === "release"}
              disabled={finishing !== null || !token}
            >
              Hand back
            </Button>
          )}
          <Button onClick={() => finish("done")} loading={finishing === "done"} disabled={finishing !== null || !token} icon="verify">
            I&apos;m signed in, save session
          </Button>
        </footer>
      </div>
    </div>
  );
}

function ClaimError({ error }: { error: unknown }) {
  const status = error instanceof DoorwayError ? error.status : 0;
  if (status === 401 || status === 403) {
    return (
      <Banner
        tone="warn"
        icon="lock"
        title="Sign in to Doorway first"
        action={
          <Link href="/login?next=/dashboard?tab=sandboxes" className="px-btn px-btn--sm">
            Sign in
          </Link>
        }
      >
        The saved session belongs to you, so taking control needs your Doorway account.
      </Banner>
    );
  }
  if (status === 409) {
    return (
      <Banner tone="warn" title="Someone else is signing in">
        Another person already took control of this sandbox.
      </Banner>
    );
  }
  if (status === 404 || status === 405) {
    return (
      <Banner tone="info" title="Can't take over right now">
        This sandbox isn&apos;t running a job you can take over (it finished, or the sandbox only allows takeover at a
        sign-in screen until the next backend update).
      </Banner>
    );
  }
  return (
    <Banner tone="bad" title="Couldn't take control">
      {describeError(error)}
    </Banner>
  );
}
