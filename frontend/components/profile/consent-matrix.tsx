"use client";

// Consent matrix: which saved fields each site may reuse. One checkbox per cell,
// optimistic toggles with rollback. POST /consents replaces a site's field set (one consent
// per user + site); an empty set is a full revoke, DELETE /consents/{id}.

import { useState } from "react";
import { doorway, type Consent, type Site, type Tool } from "@/lib/doorway";
import { TimeAgo } from "@/components/px/client";
import { Badge, Button, cx, ErrorBanner, Spinner } from "@/components/px/ui";
import { fieldLabel } from "./fields";

function withConsent(list: Consent[] | undefined, siteId: string, next: Consent | null): Consent[] {
  const rest = (list ?? []).filter((c) => c.site_id !== siteId);
  return next ? [next, ...rest] : rest;
}

function ConsentCheck({
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
    <span className="relative inline-flex items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={label}
        title={label}
        className="size-4 cursor-pointer rounded-sm accent-green disabled:cursor-wait disabled:opacity-50"
      />
      {used && (
        <span
          aria-hidden
          title="A tool on this site can fill this field"
          className="absolute -right-2.5 top-0 size-1.5 rounded-full bg-blue"
        />
      )}
    </span>
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
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
          <thead>
            <tr className="font-mono text-[11px] uppercase tracking-wider text-faint">
              <th className="sticky left-0 z-10 border-b border-line bg-panel-2 px-3 py-2 font-normal">Site</th>
              {columns.map((col) => (
                <th key={col} className="border-b border-line bg-panel-2 px-3 py-2 text-center font-normal">
                  <div className="whitespace-nowrap">{fieldLabel(col)}</div>
                  <div
                    className={cx(
                      "mt-0.5 font-sans text-[11px] normal-case tracking-normal",
                      savedFields.has(col) ? "text-faint" : "text-amber",
                    )}
                  >
                    {savedFields.has(col) ? "Saved" : "Not saved"}
                  </div>
                </th>
              ))}
              <th className="border-b border-line bg-panel-2 px-3 py-2 font-normal">Granted</th>
              <th className="border-b border-line bg-panel-2 px-3 py-2 text-right font-normal">
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
                <tr key={site.id} className="group align-middle">
                  <td className="sticky left-0 z-10 max-w-72 border-b border-line bg-panel px-3 py-2.5 group-last:border-b-0 group-hover:bg-panel-2">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-text">{site.name}</span>
                      <Badge status={site.status} />
                      {pending && <Spinner size={12} className="text-green" />}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-faint" title={usage ?? undefined}>
                      {usage ? (
                        <>
                          Used by <span className="font-mono">{usage}</span>
                        </>
                      ) : (
                        "No tools read saved details yet"
                      )}
                    </div>
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="border-b border-line px-3 py-2.5 text-center group-last:border-b-0 group-hover:bg-panel-2"
                    >
                      <ConsentCheck
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
                  <td className="whitespace-nowrap border-b border-line px-3 py-2.5 text-xs group-last:border-b-0 group-hover:bg-panel-2">
                    {consent ? (
                      consent.id < 0 ? (
                        <span className="text-faint">Saving</span>
                      ) : (
                        <TimeAgo iso={consent.granted_at} className="text-muted" />
                      )
                    ) : (
                      <span className="text-faint">Not shared</span>
                    )}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 group-last:border-b-0 group-hover:bg-panel-2">
                    <div className="flex justify-end gap-1.5">
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
      <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-faint">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-blue" /> A tool on this site can fill this
          field
        </span>
        <span className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked
            readOnly
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none size-3 rounded-sm accent-green"
          />
          Doorway may reuse it there
        </span>
      </p>
    </div>
  );
}
