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

- [x] **AC1** `ecosystem.config.cjs`: `name:"poker"`, `script:"server.ts"`, `interpreter:"node"`,
      `cwd:__dirname`, `instances: 1` (**explicit**, with a comment that in-memory room state
      forbids more), `env:{PORT:"64100",DATA_DIR:…}`, `watch:["server.ts","lib"]` ignoring
      `node_modules/data/.pm2/.pw-browsers/.cloudflared`, `autorestart`, `max_restarts`,
      `min_uptime` — mirror offtube's file.
- [x] **AC2** Port **64100** confirmed free on g2 (`ss -tlnp`) before binding; documented why it is
      outside the test band `5000-5899` and the fleet pool `13000-30242` (earthandfire took
      `64000/64001`).
- [x] **AC3** `scripts/pm2-start.sh`: nvm first, `PM2_HOME=<repo>/.pm2`, `pm2 start
      ecosystem.config.cjs`, `pm2 save` — **idempotent** (safe when the daemon already runs).
- [x] **AC4** `systemd/poker.service` → `~/.config/systemd/user/poker.service`: `Type=forking`,
      `WorkingDirectory=<repo>`, `Environment=PM2_HOME=<repo>/.pm2`, `PIDFile`, `ExecStart=…`,
      `ExecReload=… pm2 reload poker`, `ExecStop=… pm2 kill`, `Restart=always`,
      `WantedBy=default.target`; `systemctl --user enable --now poker` (no sudo), and
      `systemctl --user is-enabled poker` = `enabled`.
- [x] **AC5** **Recovery proven:** `kill -9` the node process → systemd/PM2 brings it back, and
      `/api/health` answers again within a stated time. Survives `systemctl --user restart poker`.
- [x] **AC6** `scripts/setup-cloudflare.mjs ensure` (adapted from offtube) is **idempotent** and:
      mints a scoped `poker-setup` token from
      **`/tmp/env/CLOUDFLARE_TOKEN_CREATOR` on g2**, creates the named tunnel `poker`, sets ingress
      **`poker.imre.dev → http://localhost:64100`** + `http_status:404` catch-all, upserts a
      **proxied CNAME** `poker.imre.dev → <tunnel-id>.cfargotunnel.com` in zone `imre.dev`, and
      writes `~/dev/poker/.cloudflared/{api-token,tunnel-token.env}` (0600, gitignored).
      `status` and `--dry-run` subcommands exist.
- [x] **AC7** `systemd/cloudflared.service` (user unit) runs
      `bin/cloudflared tunnel --no-autoupdate run` with
      `EnvironmentFile=<repo>/.cloudflared/tunnel-token.env`. **cloudflared is NOT under PM2.**
- [x] **AC8** **No Cloudflare Access app/policy is created** — an explicit test/check in the setup
      script's `status` output asserts the app is absent.
- [x] **AC9** **WebSockets work through the tunnel:** a client on the public origin completes
      `hello` → `vote_update` (proves no buffer/timeout rule breaks the `Upgrade`).
- [x] **AC10** `https://poker.imre.dev/api/health` → 200 from this machine; `.env` and
      `.cloudflared/` are gitignored and **no secret is ever printed or committed**.
- [x] **AC11** `README` deploy section documents: clone, `npm ci`, unit install, tunnel ensure,
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

- [x] AC1–AC11 ticked · public health check + two-client WS proof recorded in the ticket
- [x] Worktree removed, merged, pushed · ticket moved to `tickets/done/` with `git mv`

---

## Verification & landing (coordinator, 2026-09-13) — LIVE, on `hp-zbook-17-g2`

**Landed on `main`:** artifacts merged (`6def52f` → merge `dcaac6e`) and pushed, plus two coordinator glue commits: the smoke's dial path and `bin/` in `.gitignore` (`ace26d6`, `b5c2b91`). Deploy ran from `/home/imre/dev/poker` on g2 at `b5c2b91`.

| AC | Evidence |
|---|---|
| **AC1** ecosystem | `instances: 1` + `exec_mode: "fork"` explicit with the in-memory-state comment; `PORT:64100`, `DATA_DIR=<repo>/data`, `watch:["server.ts","lib"]`, required `ignore_watch`, `autorestart`/`max_restarts:10`/`min_uptime:3s`. |
| **AC2** port | `ss -tlnp` showed **64100 free** before binding; rationale (outside test band 5000-5899 and fleet pool 13000-30242; clear of earthandfire 64000/64001) is in `ecosystem.config.cjs` + `docs/DEPLOY.md`. |
| **AC3** pm2-start | Project-local `PM2_HOME`, nvm **v26.8.1** pinned; ran repeatedly with no error. |
| **AC4** systemd | `systemctl --user is-enabled poker` → **enabled**; unit `active (running)`, `Main PID: PM2 v7.0.4: God`, child `node /home/imre/dev/poker/server.ts`. |
| **AC5** recovery | `kill -9` on the node PID → back to **HTTP 200 within 1 s**, PM2 `↺ 1`, `online`; `systemctl --user restart poker` also survives (active/enabled, local + public health 200). |
| **AC6** cloudflare | `ensure` minted scoped token `42208c9768653804d6bc7a54c9528979`, created tunnel **`3a6536a9-b1f7-46b8-bc87-053ffc8ca8b2`**, ingress `poker.imre.dev → http://localhost:64100` + `http_status:404`, created a **proxied CNAME** in `imre.dev`, vendored `bin/cloudflared` **2026.9.1**, installed/enabled the tunnel unit; state files 0600. A **second `ensure` is a clean no-op** ("already present/current" on every resource) — idempotency proven. |
| **AC7** not under PM2 | `pm2 list` shows only `poker`; the tunnel runs as `poker-cloudflared.service` (separate unit, `active`, `cloudflared tunnel --no-autoupdate run`). |
| **AC8** no Access app | `setup-cloudflare.mjs status` → *"no Access app fronts poker.imre.dev (verified live; unauthenticated by design, decision 2)"*. The scoped token carries **no Access permission**, so this is structural as well as observational. |
| **AC9** WS through tunnel | `bash scripts/smoke.sh` → **SMOKE PASS**: HTTP room create over the public origin, **2× raw RFC 6455 upgrades** at `wss://poker.imre.dev/ws`, `hello → hello_ok`, `claim` both, `vote_open → vote_new`, `vote_cast → vote_update` (captured frame carries **counts only** — `"counts":{"Split":0,"Take":1},"votedCount":1`), `vote_close → vote_closed` with `reveal`. |
| **AC10** public origin | `https://poker.imre.dev/api/health` → **200** from g2 *and* from the dev workstation; g2 checkout clean; `git check-ignore` confirms `bin/`, `.cloudflared/`, `data/` ignored; no secret printed or committed. |
| **AC11** docs | `docs/DEPLOY.md` (install, port rationale, tunnel, deviation, ops) + a real `## Deploy` section in `README.md` with the install/verify/log/restart commands. |

**Deviations from the ticket text (all deliberate, all recorded):**
1. The tunnel unit is **`systemd/poker-cloudflared.service`**, not `cloudflared.service` — g2 already runs offtube's tunnel under the latter name for music.imre.dev, and installing over it would have taken that site down. Mirrors the `menu-pepper*-cloudflared.service` convention.
2. **All Cloudflare Access permission groups were dropped** from the scoped token (no-auth decision 2), so AC8's live check is best-effort: `status` always prints "no Access app" and exits 1 if one is ever visible, but the guarantee is structural — no Access permission, no Access-writing code.
3. The **smoke dialled `/` instead of `/ws`** and failed with `HTTP 404`; the server owns the upgrade at `/ws` (every other path 404s, per `001a`). Fixed as coordinator glue with the failing evidence: default is now `/ws`. Verified afterwards by the passing smoke above.
4. `bin/` (the 39 MB vendored `cloudflared`) was **not** gitignored; added, so the g2 checkout stays clean.
