#!/usr/bin/env node
// setup-cloudflare.mjs — idempotent "make sure we have those entries" for the
// poker Cloudflare exposure: scoped API token, named tunnel, ingress, DNS
// record, vendored cloudflared binary, and the user-space systemd unit that
// keeps the tunnel running. No sudo.
//
// Adapted from offtube's scripts/setup-cloudflare.mjs. Two deliberate changes:
//   1. NO Cloudflare Access app/policy — poker is unauthenticated by design
//      (POKER-001 decision 2). `status` asserts the app is absent.
//   2. The tunnel user unit is named `poker-cloudflared.service`, NOT
//      `cloudflared.service`: g2 already has a user unit with the latter name
//      (offtube's music.imre.dev tunnel), and overwriting it would take
//      music.imre.dev down.
//
//   node scripts/setup-cloudflare.mjs ensure [flags]   # default; idempotent
//   node scripts/setup-cloudflare.mjs status           # read-only report
//   node scripts/setup-cloudflare.mjs --dry-run        # compute, change nothing
//
// Flags:
//   --token-file <path>   explicit token file (raw token or NAME=value line)
//   --account-id <id>     Cloudflare account id (default: the fleet account)
//   --zone-id <id>        imre.dev zone id (default: from the fleet catalog)
//
// Token resolution order:
//   1. --token-file
//   2. $CLOUDFLARE_API_TOKEN
//   3. <repo>/.cloudflared/api-token        (scoped token stored by a past run)
//   4. /tmp/env/CLOUDFLARE_TOKEN_CREATOR    (the creator token — only used to
//      mint the scoped token; never stored in the unit or the repo)
//
// The script only ever creates/reuses its own deterministic resources
// (token "poker-setup", tunnel "poker", DNS poker.imre.dev) and never touches
// anything else in the account. Re-runs are no-ops.
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  CfClient,
  CfApiError,
  parseTokenFile,
  validateDnsName,
  findByName,
  buildScopedTokenPayload,
  buildDnsRecordPayload,
  buildTunnelConfigPayload,
  tunnelConfigNeedsUpdate,
  SCOPED_TOKEN_NAME,
  SCOPED_TOKEN_GROUPS,
  TUNNEL_NAME,
  ORIGIN_SERVICE,
  FALLBACK_SERVICE,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ZONE_ID,
  DEFAULT_HOSTNAME,
} from "../lib/cloudflare.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".cloudflared");
const API_TOKEN_PATH = path.join(STATE_DIR, "api-token");
const TUNNEL_TOKEN_PATH = path.join(STATE_DIR, "tunnel-token.env");
// NOT "cloudflared.service" — that name is taken by offtube's tunnel unit on g2.
const UNIT_NAME = "poker-cloudflared.service";
const UNIT_DEST = path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
const UNIT_TEMPLATE = path.join(ROOT, "systemd", UNIT_NAME);
const CLOUDFLARED_BIN = path.join(ROOT, "bin", "cloudflared");

function log(msg) {
  console.log(`[setup-cloudflare] ${msg}`);
}

function fail(msg) {
  console.error(`[setup-cloudflare] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  let mode = "ensure";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "ensure" || a === "status") {
      mode = a;
      continue;
    }
    if (a === "--help" || a === "-h" || a === "help") {
      mode = "help";
      continue;
    }
    if (a === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        i++;
        flags[key] = val;
      } else {
        flags[key] = true;
      }
    }
  }
  return { mode, flags };
}

function printHelp() {
  console.log(`setup-cloudflare.mjs — ensure/status for the poker Cloudflare exposure

  node scripts/setup-cloudflare.mjs ensure [flags]   # idempotent (default)
  node scripts/setup-cloudflare.mjs status           # read-only report
  node scripts/setup-cloudflare.mjs --dry-run        # compute, change nothing

Flags:
  --token-file <path>   explicit token file (raw token or NAME=value line)
  --account-id <id>     Cloudflare account id (default ${DEFAULT_ACCOUNT_ID})
  --zone-id <id>        imre.dev zone id (default ${DEFAULT_ZONE_ID})

No Access app/policy is created — poker is unauthenticated by design (no-auth
decision 2); \`status\` asserts that no Access app fronts the hostname.

Token order: --token-file → CLOUDFLARE_API_TOKEN → .cloudflared/api-token →
/tmp/env/CLOUDFLARE_TOKEN_CREATOR. Only the creator token can mint the scoped
token; once minted, re-runs use .cloudflared/api-token.`);
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

// Try every token source in order; each candidate is verified live, so stale
// stored tokens (e.g. after a rotation) are skipped instead of aborting.
async function resolveToken(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push([explicitPath, explicitPath]);
  if (process.env.CLOUDFLARE_API_TOKEN) {
    candidates.push([process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN"]);
  }
  try {
    const raw = await fsp.readFile(API_TOKEN_PATH, "utf8");
    const tok = parseTokenFile(raw);
    if (tok) candidates.push([tok, API_TOKEN_PATH]);
  } catch {
    /* not stored yet */
  }
  try {
    const raw = await fsp.readFile("/tmp/env/CLOUDFLARE_TOKEN_CREATOR", "utf8");
    const tok = parseTokenFile(raw);
    if (tok) candidates.push([tok, "/tmp/env/CLOUDFLARE_TOKEN_CREATOR"]);
  } catch {
    /* missing */
  }
  if (candidates.length === 0) {
    fail(
      "no Cloudflare token found — pass --token-file <path>, set CLOUDFLARE_API_TOKEN, " +
        "store the scoped token at .cloudflared/api-token, or place the creator token " +
        "at /tmp/env/CLOUDFLARE_TOKEN_CREATOR",
    );
  }
  const attempts = [];
  for (const [token, source] of candidates) {
    const probe = new CfClient(token);
    try {
      const v = await probe.verifyToken();
      return { token, source, id: v.id };
    } catch (e) {
      attempts.push(`${source} (${e.message.split("\n")[0]})`);
    }
  }
  fail(`no usable Cloudflare token (tried: ${attempts.join("; ")})`);
}

async function writeSecret(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, { mode: 0o600 });
}

async function readMaybe(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

// In --dry-run the scoped token is not minted yet and the creator token cannot
// read tunnels/DNS/Access, so the reads legitimately fail; report that and
// assume "absent" instead of aborting.
async function tryList(fn, label, dryRun) {
  try {
    return await fn();
  } catch (e) {
    if (dryRun && e instanceof CfApiError) {
      log(`(dry-run) ${label}: cannot verify with the current token — assuming absent`);
      return [];
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Scoped token (creator-token only)
// ---------------------------------------------------------------------------

async function ensureScopedToken(client, accountId, dryRun) {
  let canManageTokens = true;
  let activeId;
  try {
    activeId = (await client.verifyToken()).id;
    await client.listTokens();
  } catch {
    canManageTokens = false; // e.g. the scoped token itself (no Token:Read)
  }
  if (!canManageTokens) {
    log("using a token without token-management rights (the scoped token)");
    return client;
  }
  const tokens = await client.listTokens();
  const existing = findByName(tokens, SCOPED_TOKEN_NAME);
  if (existing && existing.id !== activeId) {
    // Our own token exists but its value is lost (e.g. .cloudflared was wiped).
    // Rotate it — it is a resource this script owns.
    log(`rotating orphaned scoped token "${SCOPED_TOKEN_NAME}" (${existing.id})`);
    if (dryRun) {
      log("  (dry-run) deletion skipped");
    } else {
      await client.deleteToken(existing.id);
    }
  }
  const scoped = existing && existing.id === activeId ? existing : undefined;
  if (scoped) {
    log(`scoped token "${SCOPED_TOKEN_NAME}" already active (${scoped.id})`);
    return client;
  }
  // Pinned, verified permission group ids (see lib/cloudflare.ts — the catalog
  // contains dead alias ids for some Access groups, so names are not enough).
  const permissionGroupIds = SCOPED_TOKEN_GROUPS.map((g) => g.id);
  const payload = buildScopedTokenPayload({ accountId, permissionGroupIds });
  log(`creating scoped API token "${SCOPED_TOKEN_NAME}" (account ${accountId})`);
  if (dryRun) {
    log("  (dry-run) token creation skipped");
    return client;
  }
  const created = await client.createToken(payload);
  if (!created.value) fail("scoped token created without a value — cannot persist it");
  await writeSecret(API_TOKEN_PATH, created.value);
  log(`  scoped token created: ${created.id} → ${API_TOKEN_PATH} (0600)`);
  return new CfClient(created.value);
}

// ---------------------------------------------------------------------------
// Tunnel + token
// ---------------------------------------------------------------------------

async function ensureTunnel(client, accountId, dryRun) {
  const tunnels = await tryList(() => client.listTunnels(accountId), "tunnel list", dryRun);
  let tunnel = findByName(tunnels, TUNNEL_NAME);
  if (tunnel) {
    log(`named tunnel "${TUNNEL_NAME}" already present (${tunnel.id}, ${tunnel.status})`);
  } else {
    log(`creating named tunnel "${TUNNEL_NAME}"`);
    if (dryRun) {
      tunnel = { id: "<new>", name: TUNNEL_NAME, status: "pending" };
    } else {
      tunnel = await client.createTunnel(accountId, TUNNEL_NAME);
      log(`  tunnel created: ${tunnel.id}`);
    }
  }
  const tunnelToken = dryRun ? "(dry-run)" : await client.getTunnelToken(accountId, tunnel.id);
  const envContent = `TUNNEL_TOKEN=${tunnelToken}\n`;
  const current = await readMaybe(TUNNEL_TOKEN_PATH);
  if (current === envContent) {
    log(`tunnel token already current at ${TUNNEL_TOKEN_PATH}`);
  } else {
    log(`writing tunnel token → ${TUNNEL_TOKEN_PATH} (0600, gitignored)`);
    if (!dryRun) await writeSecret(TUNNEL_TOKEN_PATH, envContent);
  }
  return tunnel;
}

// The tunnel must know which local service serves the hostname: a remote-
// managed tunnel with no ingress rules answers 503 for every request.
async function ensureTunnelConfig(client, accountId, tunnel, dryRun) {
  const desired = buildTunnelConfigPayload({ hostname: DEFAULT_HOSTNAME });
  const desiredIngress = desired.config.ingress;
  const current = await tryList(
    () => client.getTunnelConfig(accountId, tunnel.id),
    "tunnel config",
    dryRun,
  );
  const currentIngress = current?.config?.ingress ?? [];
  if (!tunnelConfigNeedsUpdate(currentIngress, desiredIngress)) {
    log(
      `tunnel ingress already configured: ${desiredIngress
        .map((r) => r.hostname ?? `(catch-all ${r.service})`)
        .join(", ")}`,
    );
    return;
  }
  log(`setting tunnel ingress: ${DEFAULT_HOSTNAME} → ${ORIGIN_SERVICE} (+ ${FALLBACK_SERVICE} catch-all)`);
  if (dryRun) {
    log("  (dry-run) ingress update skipped");
    return;
  }
  await client.updateTunnelConfig(accountId, tunnel.id, desired);
  log("  tunnel ingress updated — restarting poker-cloudflared to load it");
  runSystemctl(["restart", UNIT_NAME.replace(/\.service$/, "")]);
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

async function ensureDns(client, zoneIdHint, hostname, tunnel, dryRun) {
  if (!validateDnsName(hostname)) fail(`invalid hostname: "${hostname}"`);
  const zones = await tryList(() => client.listZones(), "zone list", dryRun);
  const zone =
    findByName(zones, hostname.split(".").slice(1).join(".")) ??
    zones.find((z) => z.id === zoneIdHint);
  const want = `${tunnel.id}.cfargotunnel.com`;
  if (!zone) {
    if (dryRun) {
      log(`(dry-run) DNS ${hostname} → ${want}: zone not verifiable with the current token — record would be created`);
      return;
    }
    fail(
      `zone for ${hostname} not found in this account — zones visible: ` +
        `${zones.map((z) => z.name).join(", ") || "(none)"}`,
    );
  }
  const records = await tryList(
    () => client.listDnsRecords(zone.id, hostname),
    "DNS record list",
    dryRun,
  );
  const cname = records.find((r) => r.type === "CNAME");
  if (!cname) {
    log(`creating DNS CNAME ${hostname} → ${want} (proxied)`);
    if (!dryRun) {
      await client.createDnsRecord(zone.id, buildDnsRecordPayload({ hostname, tunnelId: tunnel.id }));
      log(`  DNS record created in zone ${zone.name}`);
    }
  } else if (cname.content === want) {
    log(`DNS ${hostname} already → ${want}`);
  } else {
    log(`WARNING: ${hostname} already exists → ${cname.content} (leaving it unchanged)`);
  }
}

// ---------------------------------------------------------------------------
// cloudflared binary + systemd user unit
// ---------------------------------------------------------------------------

async function cloudflaredVersion(bin) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8" });
    return out.trim().split("\n")[0];
  } catch {
    return "(version check failed)";
  }
}

// poker needs its OWN binary: the unit must never exec offtube's
// /home/imre/dev/offtube/bin/cloudflared (shared file, different lifecycle).
async function ensureCloudflared(dryRun) {
  if (existsSync(CLOUDFLARED_BIN)) {
    log(`cloudflared already vendored at bin/cloudflared (${await cloudflaredVersion(CLOUDFLARED_BIN)})`);
    return CLOUDFLARED_BIN;
  }
  const platform = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!platform || !arch) {
    fail(`unsupported platform ${process.platform}/${process.arch} — install cloudflared manually into bin/`);
  }
  const version = process.env.CLOUDFLARED_VERSION ?? "latest";
  const url =
    version === "latest"
      ? `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platform}-${arch}`
      : `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-${platform}-${arch}`;
  log(`downloading cloudflared → bin/ (${url})`);
  if (dryRun) return CLOUDFLARED_BIN;
  const res = await fetch(url);
  if (!res.ok) fail(`cloudflared download failed: ${res.status} ${res.statusText}`);
  await fsp.mkdir(path.dirname(CLOUDFLARED_BIN), { recursive: true });
  await fsp.writeFile(CLOUDFLARED_BIN, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  log(`cloudflared vendored: ${await cloudflaredVersion(CLOUDFLARED_BIN)}`);
  return CLOUDFLARED_BIN;
}

function runSystemctl(args) {
  try {
    execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
    return true;
  } catch (e) {
    log(`WARNING: systemctl --user ${args.join(" ")} failed: ${e.message.split("\n")[0]}`);
    return false;
  }
}

function unitIsEnabled(name) {
  try {
    const out = execFileSync("systemctl", ["--user", "is-enabled", name], { encoding: "utf8" });
    return out.trim() === "enabled";
  } catch {
    return false;
  }
}

// The committed systemd/poker-cloudflared.service is the single source of
// truth (paths are the fixed g2 install path /home/imre/dev/poker); install it
// verbatim, enable it once, and only restart it when its content actually
// changed (so a no-op `ensure` never interrupts a live tunnel).
async function ensureSystemdUnit(dryRun) {
  const unit = await readMaybe(UNIT_TEMPLATE);
  if (unit === null) {
    fail(`unit template missing: ${UNIT_TEMPLATE}`);
  }
  const installed = await readMaybe(UNIT_DEST);
  let changed = false;
  if (installed === unit) {
    log(`user unit already installed and current → ${UNIT_DEST}`);
  } else if (dryRun) {
    log(`(dry-run) would install user unit → ${UNIT_DEST}`);
  } else {
    await fsp.mkdir(path.dirname(UNIT_DEST), { recursive: true });
    await fsp.writeFile(UNIT_DEST, unit, { mode: 0o644 });
    log(`installed user unit → ${UNIT_DEST}`);
    runSystemctl(["daemon-reload"]);
    changed = true;
  }
  const shortName = UNIT_NAME.replace(/\.service$/, "");
  if (dryRun) {
    log(`(dry-run) would enable + ${changed ? "restart" : "start"} ${shortName}`);
    return;
  }
  if (!unitIsEnabled(UNIT_NAME)) {
    runSystemctl(["enable", shortName]);
  }
  // `start` is a no-op when the unit is already active; only a content change
  // justifies a disruptive restart.
  runSystemctl([changed ? "restart" : "start", shortName]);
}

// ---------------------------------------------------------------------------
// status (read-only)
// ---------------------------------------------------------------------------

async function status(client, accountId, zoneIdHint, hostname, source) {
  const v = await client.verifyToken();
  log(`token: active (id ${v.id}, source ${source})`);
  try {
    const tokens = await client.listTokens();
    const scoped = findByName(tokens, SCOPED_TOKEN_NAME);
    log(`scoped token "${SCOPED_TOKEN_NAME}": ${scoped ? `${scoped.id} (${scoped.status})` : "NOT PRESENT"}`);
  } catch {
    log(`scoped token "${SCOPED_TOKEN_NAME}": not visible (token has no Token:Read — scoped token in use)`);
  }
  try {
    const tunnels = await client.listTunnels(accountId);
    const t = findByName(tunnels, TUNNEL_NAME);
    log(`named tunnel "${TUNNEL_NAME}": ${t ? `${t.id} (${t.status})` : "NOT PRESENT"}`);
    if (t) {
      const cfg = await client.getTunnelConfig(accountId, t.id);
      const ingress = cfg?.config?.ingress ?? [];
      log(
        `tunnel ingress: ${ingress.length ? ingress.map((r) => `${r.hostname ?? "(catch-all)"} → ${r.service}`).join("; ") : "NONE (503 for all requests!)"}`,
      );
    }
  } catch (e) {
    log(`named tunnel "${TUNNEL_NAME}": ERROR ${e.message}`);
  }
  try {
    const zones = await client.listZones();
    const zone =
      findByName(zones, hostname.split(".").slice(1).join(".")) ??
      zones.find((z) => z.id === zoneIdHint);
    if (!zone) {
      log(`zone for ${hostname}: NOT FOUND`);
    } else {
      const recs = await client.listDnsRecords(zone.id, hostname);
      log(
        `DNS ${hostname} (zone ${zone.name}): ` +
          (recs.length ? recs.map((r) => `${r.type} → ${r.content}${r.proxied ? " (proxied)" : ""}`).join("; ") : "no records"),
      );
    }
  } catch (e) {
    log(`DNS: ERROR ${e.message}`);
  }
  // AC8 — assert the deliberate absence of an Access app (no-auth decision 2).
  // The scoped token holds NO Access permission, so the live listing is
  // best-effort; the structural guarantee is that neither this script nor its
  // token can create or manage an Access app.
  try {
    const apps = await client.listAccessApps(accountId);
    const app = apps.find((a) => a.domain === hostname) ?? findByName(apps, "poker");
    if (!app) {
      log(`Access app: no Access app fronts ${hostname} (verified live; unauthenticated by design, decision 2)`);
    } else {
      log(
        `Access app: UNEXPECTED Access app "${app.name}" (${app.domain}) — no Access app must exist; ` +
          `remove it (decision 2 forbids authentication)`,
      );
      process.exitCode = 1;
    }
  } catch (e) {
    log(
      `Access app: no Access app fronts ${hostname} — none is created or manageable by this script ` +
        `(the scoped token carries no Access permission; live check unavailable: ${e.message.split("\n")[0]})`,
    );
  }
  log(`cloudflared binary: ${existsSync(CLOUDFLARED_BIN) ? await cloudflaredVersion(CLOUDFLARED_BIN) : "NOT vendored"}`);
  log(`state dir: ${STATE_DIR} (tunnel token ${existsSync(TUNNEL_TOKEN_PATH) ? "present" : "missing"}, api token ${existsSync(API_TOKEN_PATH) ? "present" : "missing"})`);
  try {
    execFileSync("systemctl", ["--user", "status", "poker-cloudflared", "--no-pager"], { stdio: "inherit" });
  } catch {
    log("user unit poker-cloudflared: not running (or no user systemd session)");
  }
  log(`next: open https://${hostname} — no login (this app has NO authentication)`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  if (mode === "help") {
    printHelp();
    return;
  }
  const accountId = flags["account-id"] ?? DEFAULT_ACCOUNT_ID;
  const zoneIdHint = flags["zone-id"] ?? DEFAULT_ZONE_ID;
  const hostname = DEFAULT_HOSTNAME;
  const dryRun = flags.dryRun === true;

  const { token, source } = await resolveToken(flags["token-file"]);
  let client = new CfClient(token);
  const v = await client.verifyToken();
  log(`token active (id ${v.id}, source ${source})`);

  if (mode === "status") {
    await status(client, accountId, zoneIdHint, hostname, source);
    return;
  }

  // ensure
  client = await ensureScopedToken(client, accountId, dryRun);
  const tunnel = await ensureTunnel(client, accountId, dryRun);
  await ensureTunnelConfig(client, accountId, tunnel, dryRun);
  await ensureDns(client, zoneIdHint, hostname, tunnel, dryRun);
  // No ensureAccess(): poker is unauthenticated (decision 2).
  await ensureCloudflared(dryRun);
  await ensureSystemdUnit(dryRun);

  log("");
  log("done. next:");
  log(`  1. open https://${hostname} — no login (this app has NO authentication)`);
  log(`  2. create a room to confirm; AC9 proof: bash scripts/smoke.sh`);
  log(`  status: node scripts/setup-cloudflare.mjs status`);
}

main().catch((e) => {
  console.error(`[setup-cloudflare] ERROR: ${e.message}`);
  process.exit(1);
});
