import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ToolPage } from "@/components/tools/tool-page";

// /tools/<id>: one tool's benchmark, versions, runs and a "Try it" form (all live, client-side).

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: PageProps<"/tools/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Tool #${id}` };
}

export default async function Page({ params }: PageProps<"/tools/[id]">) {
  const { id } = await params;
  const toolId = parseId(id);
  if (toolId === null) notFound();

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4">
      <ToolPage id={toolId} />
    </main>
  );
}
