// Errors from the Doorway API: {"detail": "..."} or {"detail": {"error": "<code>", ...}}.
// Kept apart from lib/doorway.ts so the mock can throw them without a circular import.

export class DoorwayError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: unknown = null,
  ) {
    super(code);
    this.name = "DoorwayError";
  }

  // 503 not_configured and 422 missing_inputs both carry {"missing": [..]}
  get missing(): string[] {
    const d = this.detail as { missing?: unknown } | null;
    return Array.isArray(d?.missing) ? d.missing.map(String) : [];
  }
}

export function parseDetail(status: number, body: unknown): DoorwayError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return new DoorwayError(status, detail, detail);
  if (Array.isArray(detail)) {
    // 422 validation: [{loc, msg, type}]
    const msg = detail
      .map((d: { loc?: unknown[]; msg?: string }) =>
        [Array.isArray(d.loc) ? d.loc.filter((l) => l !== "body").join(".") : "", d.msg]
          .filter(Boolean)
          .join(": "),
      )
      .join("; ");
    return new DoorwayError(status, msg || "validation_error", detail);
  }
  if (detail && typeof detail === "object") {
    const code = String((detail as { error?: unknown }).error ?? `http_${status}`);
    return new DoorwayError(status, code, detail);
  }
  return new DoorwayError(status, `http_${status}`, body);
}

// Human sentence for any error thrown by the client (used by <ErrorBanner>).
export function describeError(err: unknown): string {
  if (err instanceof DoorwayError) {
    if (err.status === 503 && err.code === "not_configured") {
      return `Backend not configured: missing ${err.missing.join(", ") || "settings"}`;
    }
    if (err.code === "missing_inputs") {
      return `Missing inputs: ${err.missing.join(", ") || "required fields"}`;
    }
    if (err.code === "unreachable") return "Doorway API is unreachable. Is the backend running?";
    if (err.status === 401) {
      return "Not signed in. Sign in, enable anonymous sign-ins in Supabase Auth, or run the backend with DOORWAY_DEMO_OPEN=1.";
    }
    if (err.status === 402) return `Payment or plan required (${err.code})`;
    if (err.status === 404) return `Not found (${err.code})`;
    if (err.status === 409) return `Conflict: ${err.code}`;
    return err.code;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
