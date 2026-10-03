// Vercel entry: every path is rewritten here (vercel.json) and handed to the clinic's fetch handler.
// The rewrite passes the original path as ?__path=...; rebuild the request URL from it so
// index.mjs routes on the path the visitor actually requested.
import app from "../index.mjs";

async function handle(req) {
  const url = new URL(req.url);
  const original = url.searchParams.get("__path");
  if (original !== null) {
    url.searchParams.delete("__path");
    url.pathname = original.startsWith("/") ? original : `/${original}`;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
  });
  return app.fetch(request);
}

export const GET = handle;
export const POST = handle;
export const HEAD = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
