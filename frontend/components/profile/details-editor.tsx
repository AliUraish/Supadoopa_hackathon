"use client";

// Saved details editor: edit, clear and save the fields Doorway may reuse (with consent).

import { useState, type FormEvent } from "react";
import { doorway, PROFILE_FIELDS, type Profile } from "@/lib/doorway";
import { useAction } from "@/lib/doorway/live";
import { Icon } from "@/components/px/icons";
import { Button, ErrorBanner, Field, Input } from "@/components/px/ui";
import { FIELD_INPUT, fieldLabel } from "./fields";

const saveProfile = (fields: Profile["fields"]) => doorway.saveProfile(fields);

export function DetailsEditor({
  saved,
  onSaved,
}: {
  saved: Record<string, string>;
  onSaved: (profile: Profile) => void;
}) {
  // null = untouched, so the inputs follow whatever the server last returned.
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [flash, setFlash] = useState(false);
  const save = useAction(saveProfile);

  const values = draft ?? saved;
  const keys = [...new Set<string>([...PROFILE_FIELDS, ...Object.keys(saved), ...Object.keys(draft ?? {})])];
  const dirty = draft !== null && keys.some((k) => (draft[k] ?? "") !== (saved[k] ?? ""));

  const edit = (key: string, value: string) => {
    setFlash(false);
    setDraft({ ...values, [key]: value });
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Blank fields are dropped: PUT replaces the whole profile.
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) fields[k] = v.trim();
    const result = await save.run(fields);
    if (!result) return;
    onSaved(result);
    setDraft(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 1800);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {keys.map((key) => {
        const input = FIELD_INPUT[key] ?? { type: "text", autoComplete: "off", placeholder: "" };
        const value = values[key] ?? "";
        const changed = (value || "") !== (saved[key] ?? "");
        return (
          <Field
            key={key}
            label={
              <span className="flex items-center gap-2">
                {fieldLabel(key)}
                <code className="font-mono text-[11px] font-normal text-faint">{key}</code>
                {changed && <span className="ml-auto text-[11px] font-normal text-amber">Edited</span>}
              </span>
            }
          >
            <span className="flex items-center gap-2">
              <Input
                name={key}
                type={input.type}
                autoComplete={input.autoComplete}
                placeholder={input.placeholder}
                value={value}
                onChange={(e) => edit(key, e.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                icon="close"
                className="shrink-0"
                aria-label={`Clear ${fieldLabel(key)}`}
                title="Clear (then Save)"
                disabled={!value || save.pending}
                onClick={() => edit(key, "")}
              />
            </span>
          </Field>
        );
      })}

      <ErrorBanner error={save.error} />

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="submit" size="sm" loading={save.pending} disabled={!dirty}>
          Save
        </Button>
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={save.pending}>
            Discard
          </Button>
        )}
        {flash && (
          <span className="animate-rise flex items-center gap-1.5 text-xs text-green" role="status">
            <Icon name="verify" size={13} />
            Saved
          </span>
        )}
        {!flash && !dirty && <span className="text-xs text-faint">Blank fields are not stored.</span>}
      </div>
    </form>
  );
}
