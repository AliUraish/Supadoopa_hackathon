// Dashboard loading screen: the dashboard's shape in skeletons (metric tiles + main panel).

import { Skeleton } from "@/components/px/ui";

export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 px-4 py-5 lg:px-6" aria-busy role="status">
      <span className="sr-only">Loading dashboard</span>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="px-panel flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="px-panel flex min-h-[420px] flex-1 flex-col">
        <div className="flex h-11 items-center justify-between gap-3 border-b border-line px-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-24" />
        </div>
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-3">
          <Skeleton className="min-h-[280px] lg:col-span-2" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
