import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray ~/package-lock.json otherwise confuses root detection.
  turbopack: { root: path.join(__dirname) },
  // drei's <Html> labels mount their own React roots; Strict Mode's dev-only double mount
  // makes them warn about unmounting during render. Production never double-mounts.
  reactStrictMode: false,
};

export default nextConfig;
