// Dashboard loading screen: the dashboard's shape in skeletons, plus a flickering door.

import { Sprite } from "@/components/px/sprite";
import { Loading, Skeleton } from "@/components/px/ui";

export default function DashboardLoading() {
  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4" aria-busy>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[78px]" />
        ))}
      </div>
      <div className="flex gap-1 border-b-2 border-line">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-28" />
        ))}
      </div>
      <div className="px-panel flex flex-1 flex-col items-center justify-center gap-2 py-16">
        <Sprite
          name="door"
          scale={6}
          className="animate-pulse-px drop-shadow-[0_0_16px_rgba(62,207,142,0.55)]"
        />
        <Loading label="Opening the dashboard" />
      </div>
    </main>
  );
}
