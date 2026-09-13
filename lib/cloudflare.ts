// lib/cloudflare.ts — Cloudflare Tunnel helpers for the poker exposure script
// (scripts/setup-cloudflare.mjs). Adapted from offtube's lib/cloudflare.ts.
//
// Pure logic + a small fetch-based API client. No side effects at import time.
// Erasable types only (Node type stripping). The API client takes an injectable
// fetch so the tests never touch the network.
//
// Resource names below are the ONLY things this project creates in the
// Cloudflare account; every helper is idempotent ("find by name, create only
// if absent") and nothing outside these names is ever modified.
//
// POKER-001 decision 2: this app is deliberately UNAUTHENTICATED, so there is
// NO Cloudflare Access app/policy here. offtube's Access-app + email-allowlist
// block is intentionally absent. The read-only Access listing helpers are kept
// solely so `status` can assert that no Access app exists for poker.imre.dev.

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export const SCOPED_TOKEN_NAME = "poker-setup";
export const TUNNEL_NAME = "poker";

// Account id (same fleet account as offtube) and the imre.dev zone id from
// menu/infrastructure/inventory/catalog.json → zones. Both are non-secret
// identifiers; the script validates them live (a mint against a wrong account
// id fails with a clear API error and creates nothing).
export const DEFAULT_ACCOUNT_ID = "4bcaeffc236393e7a52997fbf0a35767";
export const DEFAULT_ZONE_ID = "5305152ff7b35c22203f13e12c30d609";
export const DEFAULT_HOSTNAME = "poker.imre.dev";

// The local service the tunnel forwards to (the always-on pm2/systemd poker
// instance) and the catch-all the ingress MUST end with (Cloudflare requires
// the last ingress rule to match every URL).
export const ORIGIN_SERVICE = "http://localhost:64100";
export const FALLBACK_SERVICE = "http_status:404";

// Permission groups the scoped token needs, by exact catalog name (verified
// via GET /user/tokens/permission_groups; the dashboard calls these "Edit").
// IDs are pinned: the catalog exposes DUPLICATE names for some Access groups,
// and only the second ID set actually grants the write API (the first set is a
// dead alias that verifies as "success" but is ignored by the API).
//
// NO Access group at all (no-auth decision 2): poker's token physically cannot
// read, create, or manage Cloudflare Access resources, so it cannot introduce
// the authentication the parent decision forbids. `status`'s "no Access app"
// line is therefore primarily a structural assertion (see setup-cloudflare.mjs).
export const SCOPED_TOKEN_GROUPS: ReadonlyArray<{ name: string; id: string }> = [
  { name: "Zone Read", id: "c8fed203ed3043cba015a93ad1616f1f" },
  { name: "DNS Write", id: "4755a26eedb94da69e1066d98aa820be" },
  { name: "Cloudflare Tunnel Read", id: "efea2ab8357b47888938f101ae5e053f" },
  { name: "Cloudflare Tunnel Write", id: "c07321b023e944ff818fec44d8203567" },
];

export interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  messages?: unknown[];
  result: T;
}

export class CfApiError extends Error {
  readonly errors: CfEnvelope<unknown>["errors"];
  readonly status: number | undefined;

  constructor(path: string, errors: CfEnvelope<unknown>["errors"], status?: number) {
    super(`Cloudflare API ${path} failed: ${JSON.stringify(errors)}`);
    this.name = "CfApiError";
    this.errors = errors;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Token file parsing
// ---------------------------------------------------------------------------

// Accepts a raw token on a single line, or a NAME=value file (the first
// assignment wins). Returns null when nothing token-like is present.
export function parseTokenFile(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0];
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m && m[2].trim().length > 0) return m[2].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small validators / finders
// ---------------------------------------------------------------------------

export function validateDnsName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  if (name.endsWith(".")) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
}

export function findByName<T extends { name?: string }>(
  items: T[] | null | undefined,
  name: string,
): T | undefined {
  return (items ?? []).find((i) => i.name === name);
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export function buildScopedTokenPayload(opts: {
  accountId: string;
  permissionGroupIds: string[];
  name?: string;
}): Record<string, unknown> {
  return {
    name: opts.name ?? SCOPED_TOKEN_NAME,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${opts.accountId}`]: "*" },
        permission_groups: opts.permissionGroupIds.map((id) => ({ id })),
      },
    ],
  };
}

export function buildDnsRecordPayload(opts: {
  hostname: string;
  tunnelId: string;
}): Record<string, unknown> {
  return {
    type: "CNAME",
    name: opts.hostname,
    content: `${opts.tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
  };
}

export function buildTunnelConfigPayload(opts: {
  hostname: string;
  service?: string;
  fallbackService?: string;
}): Record<string, unknown> {
  return {
    config: {
      ingress: [
        { hostname: opts.hostname, service: opts.service ?? ORIGIN_SERVICE },
        { service: opts.fallbackService ?? FALLBACK_SERVICE },
      ],
    },
  };
}

function normalizeIngress(
  rules: Array<{ hostname?: string; service: string }> | null | undefined,
): Array<{ hostname: string; service: string }> {
  return (rules ?? []).map((r) => ({ hostname: r.hostname ?? "", service: r.service }));
}

// Order-insensitive comparison: the API may echo ingress keys in any order
// (e.g. "service" before "hostname"), which would otherwise look like a diff.
export function tunnelConfigNeedsUpdate(
  current: Array<{ hostname?: string; service: string }> | null | undefined,
  desired: Array<{ hostname?: string; service: string }>,
): boolean {
  return JSON.stringify(normalizeIngress(current)) !== JSON.stringify(normalizeIngress(desired));
}

// ---------------------------------------------------------------------------
// API client (fetch injected for tests)
// ---------------------------------------------------------------------------

export type FetchLike = typeof fetch;

export class CfClient {
  private readonly token: string;
  private readonly fetchFn: FetchLike;

  constructor(token: string, fetchFn: FetchLike = fetch) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const env = (await res.json()) as CfEnvelope<T>;
    if (!env.success) throw new CfApiError(`${method} ${path}`, env.errors, res.status);
    return env.result;
  }

  verifyToken(): Promise<{ id: string; status: string }> {
    return this.request("GET", "/user/tokens/verify");
  }

  listTokens(): Promise<Array<{ id: string; name: string; status: string }>> {
    return this.request("GET", "/user/tokens?per_page=100");
  }

  createToken(payload: Record<string, unknown>): Promise<{ id: string; name: string; value?: string }> {
    return this.request("POST", "/user/tokens", payload);
  }

  deleteToken(id: string): Promise<{ id: string }> {
    return this.request("DELETE", `/user/tokens/${id}`);
  }

  listPermissionGroups(): Promise<Array<{ id: string; name: string }>> {
    return this.request("GET", "/user/tokens/permission_groups");
  }

  listTunnels(accountId: string): Promise<Array<{ id: string; name: string; status: string }>> {
    return this.request("GET", `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  }

  createTunnel(accountId: string, name: string): Promise<{ id: string; name: string }> {
    return this.request("POST", `/accounts/${accountId}/cfd_tunnel`, {
      name,
      config_src: "cloudflare",
    });
  }

  getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.request("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
  }

  getTunnelConfig(
    accountId: string,
    tunnelId: string,
  ): Promise<{ config: { ingress?: Array<{ hostname?: string; service: string }> } | null }> {
    return this.request("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
  }

  updateTunnelConfig(
    accountId: string,
    tunnelId: string,
    payload: Record<string, unknown>,
  ): Promise<{ config: { ingress?: Array<{ hostname?: string; service: string }> } }> {
    return this.request("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, payload);
  }

  listZones(): Promise<Array<{ id: string; name: string; status: string }>> {
    return this.request("GET", "/zones?per_page=50");
  }

  listDnsRecords(
    zoneId: string,
    hostname: string,
  ): Promise<Array<{ id: string; name: string; type: string; content: string; proxied?: boolean }>> {
    return this.request(
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
    );
  }

  createDnsRecord(zoneId: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("POST", `/zones/${zoneId}/dns_records`, payload);
  }

  // Read-only, best-effort, and the ONLY Access call in this project. Used by
  // `status` to look for an Access app fronting poker.imre.dev. The scoped
  // token deliberately holds NO Access permission (no-auth decision 2), so this
  // is expected to fail with "Unauthorized"; status then reports the structural
  // guarantee instead. There is deliberately no create/update Access helper.
  listAccessApps(accountId: string): Promise<Array<{ id: string; name: string; domain: string }>> {
    return this.request("GET", `/accounts/${accountId}/access/apps?per_page=100`);
  }
}
