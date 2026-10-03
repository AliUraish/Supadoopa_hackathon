"use client";

// "Add website": POST /doorway/sites starts a discover job on the sandbox queue.

import { useState, type FormEvent } from "react";
import { describeError, DoorwayError, doorway, type Site } from "@/lib/doorway";
import { useAction } from "@/lib/doorway/live";
import { Banner, Button, Field, Input, Panel } from "@/components/px/ui";

export interface SiteAdded {
  site: Site;
  job_id: number;
}

function addError(err: unknown): { title: string; text: string } {
  if (err instanceof DoorwayError) {
    if (err.status === 422) {
      const why = (err.detail as { message?: unknown } | null)?.message;
      return {
        title: "Invalid URL",
        text: `That doesn't look like a website address${typeof why === "string" && why ? ` (${why})` : ""}. Use a full URL like https://example.com.`,
      };
    }
    if (err.status === 409) {
      return { title: "Already added", text: "Doorway already knows this website: find it in the list below." };
    }
    if (err.status === 401) return { title: "Not signed in", text: describeError(err) };
    if (err.status === 503) return { title: "Not configured", text: describeError(err) };
  }
  return { title: "Couldn't add website", text: describeError(err) };
}

export function AddSiteForm({ onAdded }: { onAdded: (added: SiteAdded) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const add = useAction((body: { url: string; name?: string; goal?: string }) => doorway.addSite(body));

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const res = await add.run({
      url: url.trim(),
      name: name.trim() || undefined,
      goal: goal.trim() || undefined,
    });
    if (!res) return;
    setUrl("");
    setName("");
    setGoal("");
    onAdded(res);
  };

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    if (add.error) add.reset();
  };

  const err = add.error === undefined ? null : addError(add.error);

  return (
    <Panel
      title="Add website"
      icon="plus"
      actions={<span className="hidden text-xs text-faint sm:inline">Discover, then verify in a separate sandbox</span>}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
          <Field label="Website URL" required>
            <Input
              type="url"
              required
              value={url}
              onChange={edit(setUrl)}
              placeholder="https://example.com"
              autoComplete="url"
              inputMode="url"
              disabled={add.pending}
              className="font-mono"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={edit(setName)} placeholder="Optional" disabled={add.pending} />
          </Field>
          <Field label="Goal">
            <Input
              value={goal}
              onChange={edit(setGoal)}
              placeholder="e.g. Book a table for 2"
              disabled={add.pending}
            />
          </Field>
          <Button type="submit" icon="discover" loading={add.pending}>
            {add.pending ? "Adding" : "Discover"}
          </Button>
        </div>
        <p className="text-xs text-faint">
          A sandbox explores the site and compiles each capability into a tool; a different sandbox verifies it
          before it&apos;s published.
        </p>
        {err && (
          <Banner tone="bad" title={err.title}>
            {err.text}
          </Banner>
        )}
      </form>
    </Panel>
  );
}
