import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray ~/package-lock.json otherwise confuses root detection.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
