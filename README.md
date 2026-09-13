# poker.imre.dev

A small, **no-authentication**, realtime **voting room** app for a poker night. Create a room,
claim a name, start a vote, watch the tally update live. While a vote is open nobody can see who
voted what — only how many have voted. Closing reveals; anyone can close **and reopen**.

Public: **https://poker.imre.dev** (via a Cloudflare tunnel on `hp-zbook-17-g2`).

> **Status: PLANNED.** No code yet. The full design — frozen data schema, WebSocket protocol and
> the anonymity rules — is in
> [`tickets/new/POKER-001-realtime-voting-room-app.md`](tickets/new/POKER-001-realtime-voting-room-app.md).

## What it is (and is not)

- **Is:** a realtime room + voting board with rooms, a vote history, and Matrix-style ASCII
  banners. No accounts, no email, no Cloudflare Access gate.
- **Is not:** a poker game. The name is the theme; the feature is the voting room. Poker rules are
  a possible follow-up.

## Design in one screen

| Concern | Choice |
|---|---|
| Runtime | **Node 26.8.1** (nvm), no bundler, no build step — `node server.ts` via Node type-stripping |
| Realtime | **WebSocket** on the same port as HTTP; one PM2 process (`instances: 1`) |
| Database | **One JSON file per room** — `data/rooms/<CODE>.json`. No DB, no index, no event log |
| Anonymity | While a vote is open: counts only, never names. Voter order is per-viewer, stable, **self last** |
| Tests | `node --test` unit + **Playwright from zero**, two browser contexts, spawned server on a random free port |
| Deploy | PM2 (project-local `PM2_HOME`) kept alive by an app-owned systemd **user** unit; `cloudflared` as its own user unit |
| License | **SSPL-1.0** — internal use and self-hosting free; offering it to third parties as a service requires releasing the whole stack ([plain English](RESTRICTIONS.md)) |

## Deploy

Runs on **`hp-zbook-17-g2`** as **user systemd → PM2 → `node server.ts`**, published through its own
named Cloudflare tunnel at **https://poker.imre.dev**. Full notes: [`docs/DEPLOY.md`](docs/DEPLOY.md).

**`instances: 1` is mandatory** — room state is in memory, so a second instance would serve a
different world.

```bash
git clone git@github.com:311ecode/poker.git ~/dev/poker && cd ~/dev/poker
npm ci
npm run dev:systemd:install        # poker.service (user unit; no sudo) — keeper + boot
node scripts/setup-cloudflare.mjs ensure   # scoped token, tunnel 'poker', ingress, CNAME, unit
curl -s https://poker.imre.dev/api/health  # → {"ok":true,…}
bash scripts/smoke.sh              # AC9 proof: 2 raw WS sockets through the public origin

# ops (project-local PM2_HOME — never the shared ~/.pm2)
PM2_HOME=/home/imre/dev/poker/.pm2 ~/dev/poker/node_modules/.bin/pm2 logs poker --raw
PM2_HOME=/home/imre/dev/poker/.pm2 ~/dev/poker/node_modules/.bin/pm2 restart poker
journalctl --user -u poker -f
journalctl --user -u poker-cloudflared -f
node scripts/setup-cloudflare.mjs status
```

**No authentication, by design** (no Cloudflare Access app — `status` asserts its absence). The
origin is public, so the server-side caps and rate limits are the only protection; see
[`docs/DEPLOY.md`](docs/DEPLOY.md) for the blast-radius note. The tunnel unit is deliberately named
**`poker-cloudflared.service`**: `cloudflared.service` on g2 belongs to offtube/music.imre.dev and
must not be overwritten.

## Work plan

`POKER-001` is the parent (frozen contract + coordination). Six sub-tickets run in parallel,
disjoint by owned file:

| Ticket | Slice |
|---|---|
| [POKER-001a](tickets/done/POKER-001a-server-protocol-core.md) | server + protocol spine |
| [POKER-001b](tickets/done/POKER-001b-room-file-db.md) | one-JSON-per-room atomic, serialized db |
| [POKER-001c](tickets/new/POKER-001c-browser-client-e2e.md) | browser client + Playwright e2e |
| [POKER-001d](tickets/new/POKER-001d-deploy-g2-pm2-tunnel.md) | deploy on g2 (PM2 + tunnel) |
| [POKER-001e](tickets/new/POKER-001e-ascii-ui.md) | Matrix ASCII UI |
| [POKER-001f](tickets/new/POKER-001f-fleet-descriptor-catalog.md) | fleet descriptor/catalog (menu) |

## Working on this repo

See [`AGENTS.md`](AGENTS.md) for the binding rules (tickets, git, deploy, tests).
