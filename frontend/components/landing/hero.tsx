// Landing hero: the pitch on the left, the door scene on the right.

import { ButtonLink } from "@/components/px/ui";
import { DoorHero } from "@/components/three/door-hero-client";

export function Hero() {
  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-8 px-6 pb-12 pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10 lg:pb-16 lg:pt-16">
      <div className="flex min-w-0 flex-col gap-6">
        <p className="font-mono text-[11px] uppercase tracking-wider text-faint">
          Websites <span className="text-green">→</span> verified MCP tools
        </p>
        <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-text sm:text-5xl">
          Every website, an API your agent can call.
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-muted">
          Doorway explores a site in a sandbox, compiles what it finds into typed tools, verifies them in a second
          sandbox and repairs them when the site changes.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/dashboard" size="lg" icon="overview">
            Open dashboard
          </ButtonLink>
          <ButtonLink href="#connect" size="lg" variant="ghost" icon="agent">
            Connect your agent
          </ButtonLink>
        </div>
      </div>
      <DoorHero className="h-[340px] w-full sm:h-[420px] lg:h-[480px]" />
    </section>
  );
}
