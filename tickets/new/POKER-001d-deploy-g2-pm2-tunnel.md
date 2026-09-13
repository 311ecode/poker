# POKER-001d — poker: deploy on g2 (PM2 magic + systemd keeper + Cloudflare tunnel)

**Reporter:** user — *"similar deployment like the music.imre.dev, pm2 based magic."*
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md) — decisions 1, 2, 6.
**Repo:** `311ecode/poker` (worktree `~/dev/poker-d-work`, own branch).
**Depends on:** 182a (a server that starts and answers `/api/health`).
**Parallel with:** 182b, 182c, 182e.
**Machine:** **`hp-zbook-17-g2`** — the install target. Reference: `~/dev/offtube` on g2.

## Summary

Stand up `poker.imre.dev` the offtube way: a project-local PM2 daemon owned by an app-owned
systemd user unit, a named Cloudflare tunnel created by a small idempotent setup script, a proxied
CNAME in the `imre.dev` zone, and **no Cloudflare Access app** (decision 2 — no authentication).
No Docker, no sudo.

## Requirements / Acceptance criteria

- [ ] **AC1** `ecosystem.config.cjs`: `name:"poker"`, `script:"server.ts"`, `interpreter:"node"`,
      `cwd:__dirname`, `instances: 1` (**explicit**, with a comment that in-memory room state
      forbids more), `env:{PORT:"64100",DATA_DIR:…}`, `watch:["server.ts","lib"]` ignoring
      `node_modules/data/.pm2/.pw-browsers/.cloudflared`, `autorestart`, `max_restarts`,
      `min_uptime` — mirror offtube's file.
- [ ] **AC2** Port **64100** confirmed free on g2 (`ss -tlnp`) before binding; documented why it is
      outside the test band `5000-5899` and the fleet pool `13000-30242` (earthandfire took
      `64000/64001`).
- [ ] **AC3** `scripts/pm2-start.sh`: nvm first, `PM2_HOME=<repo>/.pm2`, `pm2 start
      ecosystem.config.cjs`, `pm2 save` — **idempotent** (safe when the daemon already runs).
- [ ] **AC4** `systemd/poker.service` → `~/.config/systemd/user/poker.service`: `Type=forking`,
      `WorkingDirectory=<repo>`, `Environment=PM2_HOME=<repo>/.pm2`, `PIDFile`, `ExecStart=…`,
      `ExecReload=… pm2 reload poker`, `ExecStop=… pm2 kill`, `Restart=always`,
      `WantedBy=default.target`; `systemctl --user enable --now poker` (no sudo), and
      `systemctl --user is-enabled poker` = `enabled`.
- [ ] **AC5** **Recovery proven:** `kill -9` the node process → systemd/PM2 brings it back, and
      `/api/health` answers again within a stated time. Survives `systemctl --user restart poker`.
- [ ] **AC6** `scripts/setup-cloudflare.mjs ensure` (adapted from offtube) is **idempotent** and:
      mints a scoped `poker-setup` token from
      **`/tmp/env/CLOUDFLARE_TOKEN_CREATOR` on g2**, creates the named tunnel `poker`, sets ingress
      **`poker.imre.dev → http://localhost:64100`** + `http_status:404` catch-all, upserts a
      **proxied CNAME** `poker.imre.dev → <tunnel-id>.cfargotunnel.com` in zone `imre.dev`, and
      writes `~/dev/poker/.cloudflared/{api-token,tunnel-token.env}` (0600, gitignored).
      `status` and `--dry-run` subcommands exist.
- [ ] **AC7** `systemd/cloudflared.service` (user unit) runs
      `bin/cloudflared tunnel --no-autoupdate run` with
      `EnvironmentFile=<repo>/.cloudflared/tunnel-token.env`. **cloudflared is NOT under PM2.**
- [ ] **AC8** **No Cloudflare Access app/policy is created** — an explicit test/check in the setup
      script's `status` output asserts the app is absent.
- [ ] **AC9** **WebSockets work through the tunnel:** a client on the public origin completes
      `hello` → `vote_update` (proves no buffer/timeout rule breaks the `Upgrade`).
- [ ] **AC10** `https://poker.imre.dev/api/health` → 200 from this machine; `.env` and
      `.cloudflared/` are gitignored and **no secret is ever printed or committed**.
- [ ] **AC11** `README` deploy section documents: clone, `npm ci`, unit install, tunnel ensure,
      log/restart commands (`PM2_HOME=… pm2 logs poker --raw`, `journalctl --user -u poker`,
      `-u cloudflared`).

## Tests

```bash
# on g2, after install
systemctl --user status poker --no-pager | head
PM2_HOME=/home/imre/dev/poker/.pm2 /home/imre/dev/poker/node_modules/.bin/pm2 list
curl -s -o /dev/null -w '%{http_code}\n' https://poker.imre.dev/api/health   # → 200
node scripts/setup-cloudflare.mjs status                                     # must show "no Access app"
```

Add a **deploy smoke** (`scripts/smoke.sh` or an e2e live spec) that creates a room over the public
origin and joins it from two sockets — the AC9 proof.

## Notes for the implementer

- `pm2` is **not on PATH** on g2; it lives in the app's `node_modules/.bin`. Use
  `PM2_HOME=… node_modules/.bin/pm2`.
- Copy and adapt the parent §1.9 assets rather than writing them fresh — `scripts/pm2-start.sh`
  must pin **`/home/imre/.nvm/versions/node/v26.8.1/bin`** (offtube's says v24.15.0), and
  `scripts/setup-cloudflare.mjs` must **drop the Access-app block** (decision 2).
- Zone `imre.dev`; the zone id is in `menu/infrastructure/inventory/catalog.json` → `zones`.
- The creator token is a **bootstrap** credential: use it only to mint the scoped token, never
  store it in the repo or in `~/bash.sh/state`.
- Do **not** copy offtube's Access-app block. Blast radius of a public no-auth app: apply the
  182a rate limits before exposing it, and say so in the README.

## Done checklist

- [ ] AC1–AC11 ticked · public health check + two-client WS proof recorded in the ticket
- [ ] Worktree removed, merged, pushed · ticket moved to `tickets/done/` with `git mv`
