"use client";

// Form fields generated from a tool's input_schema (the JsonSchema subset), plus the
// coercion back to typed arguments. Inputs the tool can fill from the user's profile
// say so, and stop being required while "use my saved details" is on.

import type { ChangeEvent } from "react";
import type { JsonSchema } from "@/lib/doorway";
import { Toggle } from "@/components/px/client";
import { Field, Input, Select, Textarea } from "@/components/px/ui";

export type FieldValue = string | boolean;
export type FormValues = Partial<Record<string, FieldValue>>;

export function primaryType(s: JsonSchema): string {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (t) return t;
  if (s.enum?.length) return typeof s.enum[0] === "number" ? "number" : "string";
  if (s.properties) return "object";
  return "string";
}

function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function placeholderFor(s: JsonSchema): string | undefined {
  const ex = s.examples?.[0] ?? s.default;
  if (ex === undefined || ex === null) return undefined;
  return typeof ex === "string" ? ex : JSON.stringify(ex);
}

const FORMAT_INPUT: Record<string, string> = {
  date: "date",
  "date-time": "datetime-local",
  time: "time",
  email: "email",
  uri: "url",
  url: "url",
};

function coerce(prop: JsonSchema, raw: string): unknown {
  if (prop.enum) {
    const hit = prop.enum.find((e) => String(e) === raw);
    if (hit !== undefined) return hit;
  }
  switch (primaryType(prop)) {
    case "integer":
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true";
    case "array": {
      if (raw.startsWith("[")) {
        try {
          return JSON.parse(raw);
        } catch {
          // not JSON: treat as a comma-separated list
        }
      }
      const items = raw.split(",").map((x) => x.trim()).filter(Boolean);
      const item = prop.items;
      return item ? items.map((x) => coerce(item, x)) : items;
    }
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/** Only non-empty values, coerced to the schema's types. */
export function buildArguments(schema: JsonSchema, values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = values[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") {
      out[key] = v;
      continue;
    }
    const raw = v.trim();
    if (raw) out[key] = coerce(prop, raw);
  }
  return out;
}

export function SchemaForm({
  schema,
  values,
  onChange,
  profileFields,
  useProfile,
  disabled,
}: {
  schema: JsonSchema;
  values: FormValues;
  onChange: (key: string, value: FieldValue) => void;
  profileFields: Record<string, string>;
  useProfile: boolean;
  disabled?: boolean;
}) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  if (!props.length) return <p className="text-base text-muted">This tool takes no inputs.</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {props.map(([key, prop]) => (
        <SchemaField
          key={key}
          name={key}
          prop={prop}
          value={values[key]}
          required={required.has(key) && !(useProfile && profileFields[key])}
          profileField={profileFields[key]}
          useProfile={useProfile}
          disabled={disabled}
          onChange={(v) => onChange(key, v)}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  prop,
  value,
  required,
  profileField,
  useProfile,
  disabled,
  onChange,
}: {
  name: string;
  prop: JsonSchema;
  value: FieldValue | undefined;
  required: boolean;
  profileField: string | undefined;
  useProfile: boolean;
  disabled?: boolean;
  onChange: (value: FieldValue) => void;
}) {
  const type = primaryType(prop);
  const label = prop.title ?? humanize(name);
  const hint =
    prop.description || profileField ? (
      <>
        {prop.description}
        {profileField && (
          <span className="block text-violet">
            can autofill from your profile: <code>{profileField}</code>
          </span>
        )}
      </>
    ) : undefined;
  const placeholder =
    useProfile && profileField ? `from profile · ${profileField}` : placeholderFor(prop);
  const text = typeof value === "string" ? value : "";
  const onText = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange(e.target.value);

  if (type === "boolean") {
    const checked = typeof value === "boolean" ? value : prop.default === true;
    return (
      <Toggle
        className="self-end py-1 sm:col-span-1"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={
          <>
            {label}
            {required && <span className="text-green"> *</span>}
          </>
        }
        hint={hint}
      />
    );
  }

  if (prop.enum?.length) {
    return (
      <Field label={label} required={required} hint={hint}>
        <Select value={text} onChange={onText} required={required} disabled={disabled} name={name}>
          <option value="">{required ? "Select…" : placeholder ? `— ${placeholder}` : "—"}</option>
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  if (type === "object" || (type === "array" && prop.items && primaryType(prop.items) === "object")) {
    return (
      <Field label={label} required={required} hint={hint} className="sm:col-span-2">
        <Textarea
          value={text}
          onChange={onText}
          required={required}
          disabled={disabled}
          name={name}
          rows={3}
          placeholder={placeholder ?? (type === "object" ? "{ }" : "[ ]")}
        />
      </Field>
    );
  }

  const numeric = type === "number" || type === "integer";
  const inputType = numeric ? "number" : (prop.format && FORMAT_INPUT[prop.format]) || "text";
  return (
    <Field label={label} required={required} hint={hint}>
      <Input
        type={inputType}
        name={name}
        value={text}
        onChange={onText}
        required={required}
        disabled={disabled}
        placeholder={type === "array" ? (placeholder ?? "comma, separated") : placeholder}
        step={numeric ? (type === "integer" ? 1 : "any") : undefined}
        min={prop.minimum}
        max={prop.maximum}
        inputMode={numeric ? (type === "integer" ? "numeric" : "decimal") : undefined}
      />
    </Field>
  );
}
