export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    return Response.json({
      compute: "hello-check",
      path: pathname,
      node: process.version,
      // Names only (never values) of the env vars Compute injects.
      supabase_env: Object.keys(process.env).filter((k) => k.startsWith("SUPABASE")).sort(),
      port: process.env.PORT ?? null,
      time: new Date().toISOString(),
    });
  },
};
