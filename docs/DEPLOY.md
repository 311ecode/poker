# Deploying poker on g2 (`poker.imre.dev`)

Self-supervised deploy, same shape as `offtube`/`music.imre.dev`:

```
user systemd (poker.service)  →  PM2 (project-local .pm2)  →  node server.ts  →  :64100
user systemd (poker-cloudflared.service)  →  cloudflared tunnel  →  Cloudflare edge  →  poker.imre.dev
```

No Docker, no sudo. PM2 state is **project-local** (`/home/imre/dev/poker/.pm2`), never `~/.pm2`.

> **Security posture — no authentication.** `poker` is deliberately unauthenticated (POKER-001
> decision 2). There is **no Cloudflare Access app/policy**, and the setup script never creates
> one. Anyone who knows the URL can use it, so the server's own rate limits (`POKER-001a`) are the
> only protection and must be live before the hostname is published.

## 0. Files

| File | Role |
|---|---|
| `ecosystem.config.cjs` | PM2 app (`poker`, `instances: 1`, port 64100, `DATA_DIR=<repo>/data`) |
| `scripts/pm2-start.sh` | Boots PM2 + `pm2 save`; run by the keeper unit |
| `systemd/poker.service` | User unit that owns the PM2 daemon |
| `systemd/poker-cloudflared.service` | User unit that runs the tunnel |
| `scripts/setup-cloudflare.mjs` | `ensure` / `status` / `--dry-run` for token+tunnel+ingress+DNS+unit |
| `lib/cloudflare.ts` | Tunnel/token/DNS/ingress helpers (no Access writers) |
| `scripts/smoke.sh`, `scripts/smoke.mjs` | AC9 proof: HTTP room create + 2× raw-WS hello → vote |

## 1. Install

On **`hp-zbook-17-g2`**, in `/home/imre/dev/poker`:

```bash
nvm use 26.8.1
npm ci --cache .npm-cache
```

The unit files hard-code `/home/imre/dev/poker` — install there, not in a worktree.

### Port 64100

The tunnel forwards only to `http://localhost:64100`. Confirm it is free before the first bind:

```bash
ss -tlnp | grep 64100 || echo "64100 free"
```

Why 64100: it is outside the e2e/test band **5000–5899**, outside the fleet pool
**13000–30242**, and clear of earthandfire's **64000/64001**. Do not move it without updating the
tunnel ingress.

## 2. PM2 keeper (user systemd, no sudo)

```bash
cp systemd/poker.service ~/.config/systemd/user/poker.service
systemctl --user daemon-reload
systemctl --user enable --now poker
systemctl --user is-enabled poker          # → enabled
```

`poker.service` is `Type=forking` and tracks the PM2 daemon via
`PIDFile=/home/imre/dev/poker/.pm2/pm2.pid`; `ExecStart` runs `scripts/pm2-start.sh`
(`pm2 start ecosystem.config.cjs` + `pm2 save`), `ExecReload` reloads the `poker` app and
`ExecStop` runs `pm2 kill`. `Restart=always` brings the daemon (and app) back if it dies.

`instances: 1` is mandatory: room/vote state lives in memory, so a second instance would serve a
different world.

## 3. Cloudflare tunnel

The scoped-token bootstrap uses the creator token at `/tmp/env/CLOUDFLARE_TOKEN_CREATOR` — it is
only read to mint the scoped token and is never stored.

```bash
node scripts/setup-cloudflare.mjs status        # read-only
node scripts/setup-cloudflare.mjs --dry-run     # compute, change nothing
node scripts/setup-cloudflare.mjs ensure        # idempotent
```

`ensure` mints the `poker-setup` token, creates/reuses the named tunnel `poker`, sets the ingress
`poker.imre.dev → http://localhost:64100` plus an `http_status:404` catch-all, upserts a proxied
CNAME `poker.imre.dev → <tunnel-id>.cfargotunnel.com` in the `imre.dev` zone, vendors
`bin/cloudflared` if missing, and installs/starts the tunnel unit. State is written to
`.cloudflared/{api-token,tunnel-token.env}` (`0600`, gitignored).

`status` explicitly reports **no Access app** fronting `poker.imre.dev` (and fails if one is ever
visible). The scoped token is minted with **no Access permission group at all**, so this project
cannot create or manage an Access app; the live listing is best-effort and the absence is primarily
a structural guarantee (Cloudflare refuses the Access read with that token).

### Deviation: the tunnel unit is `poker-cloudflared.service`, not `cloudflared.service`

g2 **already runs offtube's tunnel** as the user unit `cloudflared.service` (music.imre.dev,
currently active). Installing poker's tunnel at that name would overwrite it and take
music.imre.dev down. poker therefore uses `systemd/poker-cloudflared.service` →
`~/.config/systemd/user/poker-cloudflared.service`, with `SyslogIdentifier=poker-cloudflared`,
mirroring the existing `menu-pepper*-cloudflared.service` naming on g2. **Never** copy poker's unit
over `cloudflared.service`.

### cloudflared binary

poker needs its **own** binary at `/home/imre/dev/poker/bin/cloudflared`; it must not exec
offtube's file. `setup-cloudflare.mjs ensure` downloads it if absent (skipped under `--dry-run`).
Offline alternative:

```bash
mkdir -p bin && cp /home/imre/dev/offtube/bin/cloudflared bin/cloudflared && chmod 755 bin/cloudflared
bin/cloudflared --version
```

## 4. Verify the deploy

```bash
systemctl --user status poker --no-pager | head
PM2_HOME=/home/imre/dev/poker/.pm2 /home/imre/dev/poker/node_modules/.bin/pm2 list
curl -s -o /dev/null -w '%{http_code}\n' https://poker.imre.dev/api/health   # → 200
node scripts/setup-cloudflare.mjs status                                     # → "no Access app"
bash scripts/smoke.sh                                                        # AC9: hello → vote
```

`smoke.sh` creates a room over the public origin and drives two hand-rolled RFC 6455 sockets
through `hello → hello_ok → claim → vote_open → vote_cast → vote_update → vote_close → vote_closed`,
asserting the open `vote_update` carries counts only. If `POKER-001a` lands the WS upgrade on a
non-root path, pass it: `bash scripts/smoke.sh --ws-path /ws` (or `--ws-url wss://…`).

### Recovery (AC5)

```bash
pkill -9 -f "node server.ts"     # PM2 restarts it; /api/health answers again within ~5s
systemctl --user restart poker   # survives a full keeper restart
```

## 5. Logs / restart / lifecycle

```bash
# app
PM2_HOME=/home/imre/dev/poker/.pm2 /home/imre/dev/poker/node_modules/.bin/pm2 logs poker --raw
PM2_HOME=/home/imre/dev/poker/.pm2 /home/imre/dev/poker/node_modules/.bin/pm2 restart poker
journalctl --user -u poker -f
systemctl --user restart poker

# tunnel
journalctl --user -u poker-cloudflared -f
systemctl --user restart poker-cloudflared
bin/cloudflared --version
```

Uninstall (from `package.json` scripts): `npm run dev:systemd:uninstall` and
`npm run dev:cloudflare:uninstall` — both target `poker`/`poker-cloudflared` only and will never
touch offtube's `cloudflared.service`.

## 6. Secrets

`.env` and `.cloudflared/` are gitignored and per-machine. The creator token stays at
`/tmp/env/CLOUDFLARE_TOKEN_CREATOR` and is never copied into the repo; only the minted scoped
token is stored (`.cloudflared/api-token`, `0600`). Never print or commit either.
