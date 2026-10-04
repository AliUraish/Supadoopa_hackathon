// Interactive sign-in: when a sandbox stops at a login wall, the user drives its browser.
// These calls go straight to the sandbox's live-view service (the /doorway/live `url`).
// Claim first (Supabase login required): the control token then unlocks the screen and input.
// Passwords are typed into the site's own form; Doorway only keeps the resulting session.

import { authHeader } from "@/lib/doorway";
import { DoorwayError, parseDetail } from "@/lib/doorway/errors";

export type TakeoverInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number };

export interface Claim {
  control_token: string;
  viewport: { width: number; height: number } | null;
  expires_at: string | null;
}

async function post<T>(url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new DoorwayError(0, "unreachable");
  }
  if (!res.ok) throw parseDetail(res.status, await res.json().catch(() => null));
  return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
}

const id = encodeURIComponent;
const tok = (token: string) => ({ "X-Takeover-Token": token });

export const takeover = {
  /** Take control of a waiting sandbox (needs a Supabase session). */
  claim: async (liveUrl: string, sandbox: string) =>
    post<Claim>(`${liveUrl}takeover/${id(sandbox)}/claim`, await authHeader()),
  /** One click, keystroke batch, key press or scroll in the sandbox's browser. */
  input: (liveUrl: string, sandbox: string, token: string, input: TakeoverInput) =>
    post<void>(`${liveUrl}input/${id(sandbox)}`, tok(token), input),
  /** Signed in: save the session and let the sandbox carry on exploring. */
  done: (liveUrl: string, sandbox: string, token: string) =>
    post<void>(`${liveUrl}takeover/${id(sandbox)}/done`, tok(token)),
  /** Hand control back: the job resumes, nothing is saved. */
  release: (liveUrl: string, sandbox: string, token: string) =>
    post<void>(`${liveUrl}takeover/${id(sandbox)}/release`, tok(token)),
  /** Give up: the job fails with "sign-in cancelled". */
  cancel: (liveUrl: string, sandbox: string, token: string) =>
    post<void>(`${liveUrl}takeover/${id(sandbox)}/cancel`, tok(token)),
  streamUrl: (liveUrl: string, sandbox: string, token: string) =>
    `${liveUrl}stream/${id(sandbox)}?token=${id(token)}`,
  frameUrl: (liveUrl: string, sandbox: string, token: string, tick: number) =>
    `${liveUrl}frame/${id(sandbox)}?token=${id(token)}&t=${tick}`,
};
