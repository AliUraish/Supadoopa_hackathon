// One site: its capabilities, tools, live events, demo controls and MCP endpoint.

import type { Metadata } from "next";
import { SitePage } from "@/components/site/site-page";

function siteId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: PageProps<"/sites/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: siteId(id) };
}

export default async function Page({ params }: PageProps<"/sites/[id]">) {
  const { id } = await params;
  return <SitePage id={siteId(id)} />;
}
