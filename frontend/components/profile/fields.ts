// Profile field vocabulary shared by the details editor and the consent matrix.

import { PROFILE_FIELDS, type Consent, type Profile, type Tool } from "@/lib/doorway";

const LABELS: Record<string, string> = {
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  address: "Address",
};

export function fieldLabel(key: string): string {
  return LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const FIELD_INPUT: Record<string, { type: string; autoComplete: string; placeholder: string }> = {
  full_name: { type: "text", autoComplete: "name", placeholder: "Ada Lovelace" },
  email: { type: "email", autoComplete: "email", placeholder: "ada@example.com" },
  phone: { type: "tel", autoComplete: "tel", placeholder: "+1 555 0100" },
  address: { type: "text", autoComplete: "street-address", placeholder: "12 Analytical Row, London" },
};

/** The backend stores any JSON; the editor only deals in strings. */
export function profileStrings(fields: Profile["fields"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** Standard fields first, then anything else the profile, consents or tools mention. */
export function allFields(...groups: Iterable<string>[]): string[] {
  const seen = new Set<string>(PROFILE_FIELDS);
  for (const group of groups) for (const f of group) seen.add(f);
  return [...seen];
}

export function consentFields(consents: Consent[] | undefined): string[] {
  return (consents ?? []).flatMap((c) => c.fields);
}

export function toolFields(tools: Tool[] | undefined): string[] {
  return (tools ?? []).flatMap((t) => Object.values(t.profile_fields ?? {}));
}
