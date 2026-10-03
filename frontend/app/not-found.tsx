import { DoorwayMark } from "@/components/brand/doorway-logo";
import { ButtonLink } from "@/components/px/ui";

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <DoorwayMark size={32} className="text-faint" />
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-faint">404</p>
          <h1 className="text-xl font-semibold tracking-tight text-text">This door leads nowhere</h1>
          <p className="text-[13px] text-muted">No page, site or tool lives at this address. It may have moved.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <ButtonLink href="/dashboard">Open dashboard</ButtonLink>
          <ButtonLink href="/" variant="ghost">
            Home
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
