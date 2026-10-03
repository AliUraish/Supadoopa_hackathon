"use server";

import { createClient } from "@/lib/supabase/server";
import { DEMO_SITE } from "./site";

type Result = { ok: boolean; error?: string; version?: string };

// Demo controls spend Claude credits and change the live site: signed-in users only,
// unless DEMO_CONTROLS_OPEN=1 (or local dev) for rehearsals.
async function allowed() {
  if (process.env.NODE_ENV !== "production" || process.env.DEMO_CONTROLS_OPEN === "1") return true;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

async function clinic(path: string, body?: unknown) {
  const res = await fetch(`${process.env.CLINIC_URL}/admin/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-admin-token": process.env.CLINIC_ADMIN_TOKEN ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`clinic admin ${res.status}`);
  return res.json() as Promise<{ version: string }>;
}

export async function getClinicVersion(): Promise<string | null> {
  try {
    return (await clinic("state")).version;
  } catch {
    return null;
  }
}

export async function exploreSite(): Promise<Result> {
  if (!(await allowed())) return { ok: false, error: "Sign in to control the demo" };
  const res = await fetch(`${process.env.DOORWAY_URL}/sites`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.DOORWAY_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...DEMO_SITE, base_url: `${process.env.CLINIC_URL}/` }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, error: "Doorway is unreachable" };
  if (!res.ok) return { ok: false, error: (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}` };
  return { ok: true };
}

export async function setClinicVersion(version: "v1" | "v2"): Promise<Result> {
  if (!(await allowed())) return { ok: false, error: "Sign in to control the demo" };
  try {
    return { ok: true, version: (await clinic("version", { version })).version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "clinic unreachable" };
  }
}

export async function resetDemo(): Promise<Result> {
  if (!(await allowed())) return { ok: false, error: "Sign in to control the demo" };
  try {
    return { ok: true, version: (await clinic("reset", {})).version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "clinic unreachable" };
  }
}
