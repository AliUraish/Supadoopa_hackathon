"use client";

// Consent matrix: which saved fields each site may reuse. One pixel checkbox per cell,
// optimistic toggles with rollback. POST /consents replaces a site's field set (one consent
// per user + site); an empty set is a full revoke, DELETE /consents/{id}.

import { useState, type CSSProperties } from "react";
import { doorway, type Consent, type Site, type Tool } from "@/lib/doorway";
import { PixelIcon } from "@/components/px/icons";
import { TimeAgo } from "@/components/px/client";
import { Badge, Button, cx, ErrorBanner } from "@/components/px/ui";
import { fieldLabel } from "./fields";

function withConsent(list: Consent[] | undefined, siteId: string, next: Consent | null): Consent[] {
  const rest = (list ?? []).filter((c) => c.site_id !== siteId);
  return next ? [next, ...rest] : rest;
}

function PixelCheck({
  checked,
  used,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  used: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className="px-frame relative inline-grid size-7 place-items-center hover:brightness-125 disabled:cursor-wait disabled:opacity-50"
      style={
        {
          "--frame": checked ? "var(--color-green)" : "var(--color-line-2)",
          background: checked ? "var(--color-green-deep)" : "var(--color-bg-2)",
        } as CSSProperties
      }
    >
      {checked && <PixelIcon name="verify" size={14} className="text-green-hi" />}
      {used && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 bg-blue" />}
    </button>
  );
}

/** "book_appointment (patient_name ← full_name, phone ← phone)" for tools that read the profile. */
function usageLine(tools: Tool[]): string | null {
  const parts = tools
    .filter((t) => Object.keys(t.profile_fields ?? {}).length)
    .map(
      (t) =>
        `${t.name} (${Object.entries(t.profile_fields)
          .map(([input, field]) => `${input} ← ${field}`)
          .join(", ")})`,
    );
  return parts.length ? parts.join(" · ") : null;
}

export function ConsentMatrix({
  sites,
  consents,
  columns,
  toolsBySite,
  savedFields,
  onChange,
}: {
  sites: Site[];
  consents: Consent[];
  columns: string[];
  toolsBySite: Map<string, Tool[]>;
  savedFields: Set<string>;
  onChange: (fn: (prev: Consent[] | undefined) => Consent[] | undefined) => void;
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<unknown>(undefined);

  const setFields = async (site: Site, wanted: string[]) => {
    const prev = consents.find((c) => c.site_id === site.id) ?? null;
    const fields = [...columns.filter((c) => wanted.includes(c)), ...wanted.filter((w) => !columns.includes(w))];
    setError(undefined);
    setBusy((b) => ({ ...b, [site.id]: true }));
    onChange((list) =>
      withConsent(
        list,
        site.id,
        fields.length
          ? { id: prev?.id ?? -1, site_id: site.id, fields, granted_at: new Date().toISOString() }
          : null,
      ),
    );
    try {
      if (!fields.length) {
        if (prev) await doorway.revokeConsent(prev.id);
      } else {
        const granted = await doorway.grantConsent(site.id, fields);
        onChange((list) => withConsent(list, site.id, granted));
      }
    } catch (err) {
      onChange((list) => withConsent(list, site.id, prev));
      setError(err);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[site.id];
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner
        error={error}
        action={
          <Button variant="ghost" size="sm" onClick={() => setError(undefined)}>
            Dismiss
          </Button>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr className="font-pixel text-[8px] uppercase text-muted">
              <th className="sticky left-0 z-10 bg-panel py-2 pr-3 font-normal">Site</th>
              {columns.map((col) => (
                <th key={col} className="px-2 py-2 text-center font-normal">
                  <div>{fieldLabel(col)}</div>
                  <div className={cx("font-term text-sm normal-case", savedFields.has(col) ? "text-faint" : "text-amber")}>
                    {savedFields.has(col) ? "saved" : "not saved"}
                  </div>
                </th>
              ))}
              <th className="px-2 py-2 font-normal">Granted</th>
              <th className="py-2 pl-2 text-right font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => {
              const consent = consents.find((c) => c.site_id === site.id);
              const granted = new Set(consent?.fields ?? []);
              const tools = toolsBySite.get(site.id) ?? [];
              const used = new Set(tools.flatMap((t) => Object.values(t.profile_fields ?? {})));
              const usage = usageLine(tools);
              const pending = Boolean(busy[site.id]);
              const allOn = columns.every((c) => granted.has(c));
              return (
                <tr key={site.id} className="align-middle">
                  <td className="sticky left-0 z-10 max-w-72 border-t-2 border-line bg-panel py-2.5 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-lg text-text">{site.name}</span>
                      <Badge status={site.status} />
                      {pending && <PixelIcon name="compile" size={10} className="px-spin text-green" />}
                    </div>
                    <div className="truncate text-sm text-faint" title={usage ?? undefined}>
                      {usage ? `used by ${usage}` : "no tools read saved details yet"}
                    </div>
                  </td>
                  {columns.map((col) => (
                    <td key={col} className="border-t-2 border-line px-2 py-2.5 text-center">
                      <PixelCheck
                        checked={granted.has(col)}
                        used={used.has(col)}
                        disabled={pending}
                        label={`${granted.has(col) ? "Revoke" : "Allow"} ${fieldLabel(col)} for ${site.name}`}
                        onToggle={() =>
                          setFields(
                            site,
                            granted.has(col) ? [...granted].filter((f) => f !== col) : [...granted, col],
                          )
                        }
                      />
                    </td>
                  ))}
                  <td className="whitespace-nowrap border-t-2 border-line px-2 py-2.5 text-base">
                    {consent ? (
                      consent.id < 0 ? (
                        <span className="text-faint">saving…</span>
                      ) : (
                        <TimeAgo iso={consent.granted_at} className="text-muted" />
                      )
                    ) : (
                      <span className="text-faint">not shared</span>
                    )}
                  </td>
                  <td className="border-t-2 border-line py-2.5 pl-2">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending || allOn}
                        onClick={() => setFields(site, columns)}
                      >
                        Allow all
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={pending || !consent}
                        onClick={() => setFields(site, [])}
                      >
                        Revoke
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-faint">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 bg-blue" /> a tool on this site can fill this field
        </span>
        <span className="flex items-center gap-1.5">
          <PixelIcon name="verify" size={10} className="text-green" /> Doorway may reuse it there
        </span>
      </p>
    </div>
  );
}
