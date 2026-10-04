"use client";

// /profile: saved details + per-site consent. No login: the client quietly starts an
// anonymous Supabase session for the private calls.

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { doorway, DoorwayError, type Tool } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { Icon, type IconName } from "@/components/px/icons";
import { Banner, Button, ButtonLink, Empty, ErrorBanner, Loading, Panel, Skeleton } from "@/components/px/ui";
import { ConnectedSites } from "./connected-sites";
import { ConsentMatrix } from "./consent-matrix";
import { DetailsEditor } from "./details-editor";
import { allFields, consentFields, profileStrings, toolFields } from "./fields";

const is401 = (err: unknown) => err instanceof DoorwayError && err.status === 401;

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-panel-3 px-1 py-px font-mono text-xs text-text">{children}</code>;
}

function HowItem({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-panel-2 text-muted">
        <Icon name={icon} size={14} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text">{title}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Retry
    </Button>
  );
}

export function ProfilePage({ guest }: { guest: boolean }) {
  const profile = useLive("profile", () => doorway.profile(), { poll: false });
  const consents = useLive("consents", () => doorway.consents(), { poll: false });
  const sites = useLive("profile:sites", () => doorway.sites(), { poll: false });
  const tools = useLive("profile:tools", () => doorway.tools(), { tables: ["doorway_tools"], poll: false });

  const saved = useMemo(() => profileStrings(profile.data?.fields), [profile.data]);
  const toolsBySite = useMemo(() => {
    const map = new Map<string, Tool[]>();
    for (const t of tools.data ?? []) map.set(t.site_id, [...(map.get(t.site_id) ?? []), t]);
    return map;
  }, [tools.data]);
  const columns = allFields(Object.keys(saved), consentFields(consents.data), toolFields(tools.data));
  const savedFields = new Set(Object.keys(saved).filter((k) => saved[k].trim()));

  const authError = [profile.error, consents.error].find(is401);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-5 px-4 py-6 lg:px-6">
      <header className="flex flex-col gap-1.5 border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-text">Your saved details</h1>
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
          Save your details once. Doorway only reuses them to fill forms on sites you allow, and only the fields
          you allow. Nothing is shared without consent.
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
          <Icon name={guest ? "user" : "lock"} size={13} />
          {guest ? "You're a guest: details are kept in an anonymous session in this browser." : "Stored with your account."}
          {guest && (
            <Link href="/login?next=/profile" className="text-green underline-offset-2 hover:underline">
              Sign in to keep them
            </Link>
          )}
        </p>
      </header>

      {authError !== undefined && (
        <Banner
          tone="bad"
          icon="lock"
          title="No session"
          action={
            <ButtonLink href="/login?next=/profile" size="sm">
              Sign in
            </ButtonLink>
          }
        >
          Saved details are private, so Doorway needs a session. Sign in, or enable anonymous sign-ins in
          Supabase Auth so guests get one automatically.
        </Banner>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <Panel title="Saved details" icon="user" className="lg:col-span-4">
          {profile.loading ? (
            <div className="flex flex-col gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-9" />
                </div>
              ))}
            </div>
          ) : profile.error ? (
            is401(profile.error) ? (
              <Empty icon="lock" title="Locked" hint="Needs a session (see above)." />
            ) : (
              <ErrorBanner error={profile.error} action={<RetryButton onClick={profile.refresh} />} />
            )
          ) : (
            <DetailsEditor saved={saved} onSaved={(p) => profile.mutate(() => p)} />
          )}
        </Panel>

        <Panel
          title="Who can use them"
          icon="lock"
          className="lg:col-span-8"
          actions={<span className="hidden text-xs text-faint sm:inline">One row per site, one box per field</span>}
        >
          {sites.loading || consents.loading ? (
            <Loading label="Loading consents" />
          ) : sites.error ? (
            <ErrorBanner error={sites.error} action={<RetryButton onClick={sites.refresh} />} />
          ) : consents.error ? (
            is401(consents.error) ? (
              <Empty icon="lock" title="Locked" hint="Needs a session (see above)." />
            ) : (
              <ErrorBanner error={consents.error} action={<RetryButton onClick={consents.refresh} />} />
            )
          ) : !sites.data?.length ? (
            <Empty
              icon="site"
              title="No sites yet"
              hint="Add a website from the dashboard; it shows up here once Doorway knows it."
              action={
                <ButtonLink href="/dashboard?tab=sites" size="sm">
                  Open dashboard
                </ButtonLink>
              }
            />
          ) : (
            <ConsentMatrix
              sites={sites.data}
              consents={consents.data ?? []}
              columns={columns}
              toolsBySite={toolsBySite}
              savedFields={savedFields}
              onChange={consents.mutate}
            />
          )}
        </Panel>
      </div>

      <Panel title="How it's used" icon="tool">
        <div className="grid gap-5 md:grid-cols-3">
          <HowItem icon="agent" title="Only blank inputs">
            An agent calls a tool with <Code>use_profile</Code>: Doorway fills only the blank inputs, from fields you
            ticked for that site.
          </HowItem>
          <HowItem icon="pattern" title="Declared mappings">
            Each tool declares its mapping, e.g. <Code>patient_name ← full_name</Code>. Unticked fields are never
            read.
          </HowItem>
          <HowItem icon="lock" title="Consent is separate">
            <Code>remember</Code> saves submitted inputs back here. Consent is always a separate, explicit step.
          </HowItem>
        </div>
      </Panel>

      <ConnectedSites />
    </div>
  );
}
