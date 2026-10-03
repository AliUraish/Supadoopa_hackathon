// Only allow same-site relative redirects (blocks `//evil.com` and absolute URLs).
export function safeNext(next: unknown, fallback = "/dashboard") {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
    ? next
    : fallback;
}
