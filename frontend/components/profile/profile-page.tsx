"use client";

// /profile: saved details + per-site consent. No login: in real mode the client quietly
// starts an anonymous Supabase session for the 🔒 calls.

import Link from "next/link";
import { useMemo } from "react";
import { doorway, DoorwayError, DOORWAY_MOCK, type Tool } from "@/lib/doorway";
import { useLive } from "@/lib/doorway/live";
import { Sprite } from "@/components/px/sprite";
import { Banner, Button, ButtonLink, Empty, ErrorBanner, Loading, Panel, Skeleton } from "@/components/px/ui";
import { ConsentMatrix } from "./consent-matrix";
import { DetailsEditor } from "./details-editor";
import { allFields, consentFields, profileStrings, toolFields } from "./fields";

const is401 = (err: unknown) => err instanceof DoorwayError && err.status === 401;

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
    <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center gap-5">
        <Sprite name="agent" scale={4} className="drop-shadow-[0_0_10px_rgba(62,207,142,0.45)]" />
        <div className="min-w-0 flex-1">
          <h1 className="font-pixel text-[16px] uppercase text-green px-glow">Your saved details</h1>
          <p className="mt-2 max-w-3xl text-xl text-text">
            Save your details once. Doorway only reuses them to fill forms on sites you allow, and only the
            fields you allow. Nothing is shared without consent.
          </p>
          <p className="mt-1 text-base text-faint">
            {DOORWAY_MOCK
              ? "Mock mode: changes live in this tab only."
              : guest
                ? "You're a guest: details are kept in an anonymous session in this browser. "
                : "Stored with your account."}
            {!DOORWAY_MOCK && guest && (
              <Link href="/login?next=/profile" className="text-green underline">
                Sign in to keep them
              </Link>
            )}
          </p>
        </div>
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
                <Skeleton key={i} className="h-12" />
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
          actions={<span className="text-base text-faint">one row per site · one box per field</span>}
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
        <ul className="grid gap-x-6 gap-y-1 text-base text-muted md:grid-cols-3">
          <li>
            <span className="text-green">▸</span> An agent calls a tool with <code className="text-text">use_profile</code>:
            Doorway fills only the <em>blank</em> inputs, from fields you ticked for that site.
          </li>
          <li>
            <span className="text-green">▸</span> Each tool declares its mapping, e.g.{" "}
            <code className="text-text">patient_name ← full_name</code>. Unticked fields are never read.
          </li>
          <li>
            <span className="text-green">▸</span> <code className="text-text">remember</code> saves submitted inputs
            back here. Consent is always a separate, explicit step.
          </li>
        </ul>
      </Panel>
    </main>
  );
}
