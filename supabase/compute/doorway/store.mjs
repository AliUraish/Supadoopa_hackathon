// Storage for sites, tool versions and the live event feed.
// MemoryStore runs locally with no setup; SupabaseStore (added once the tables exist)
// keeps the same interface so the server doesn't care which one it gets.

export class MemoryStore {
  constructor() {
    this.sites = new Map(); // id -> { id, name, base_url, goal, status }
    this.tools = new Map(); // site id -> { version, specs, status, verified_at }
    this.events = [];
  }

  async upsertSite(site) {
    const prev = this.sites.get(site.id) ?? {};
    this.sites.set(site.id, { status: "new", ...prev, ...site });
    return this.sites.get(site.id);
  }
  async getSite(id) { return this.sites.get(id) ?? null; }
  async listSites() { return [...this.sites.values()]; }

  async getTools(siteId) { return this.tools.get(siteId) ?? null; }
  async saveTools(siteId, { specs, status, verification, source }) {
    const prev = this.tools.get(siteId);
    const next = {
      version: (prev?.version ?? 0) + 1, specs, status, verification, source,
      verified_at: status === "verified" ? new Date().toISOString() : null,
    };
    this.tools.set(siteId, next);
    return next;
  }

  async event(siteId, kind, message, data = {}) {
    const e = { id: this.events.length + 1, site_id: siteId, kind, message, data, created_at: new Date().toISOString() };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    console.log(`[${siteId}] ${kind}: ${message}`);
    return e;
  }
  async listEvents(siteId, sinceId = 0) {
    return this.events.filter((e) => (!siteId || e.site_id === siteId) && e.id > sinceId);
  }
}
