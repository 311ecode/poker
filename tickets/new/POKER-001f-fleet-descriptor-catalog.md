# POKER-001f — poker: fleet descriptor + catalog onboarding (dashboard visibility)

**Reporter:** follow-on of the parent — the fleet must know the app exists.
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md).
**Repo:** **`menu`** (branch **`newMaster`**) — descriptor + catalog only. The app repo is not
touched here.
**Depends on:** **182d live** (`https://poker.imre.dev/api/health` → 200). Do not file the catalog
entry for a host that cannot serve it.
**Model:** `offtube` (music.imre.dev) and `earthandfire` — the proven self-supervised onboarding
(DASH-170, INFRA-137d).

## Summary

Declare `poker` as an app + environment in the fleet inventory so the dashboard shows its group and
probes it, using the self-supervised shape (`supervisor: "self"`, PM2, its own systemd keeper).
No `menu-ctl.sh`, no per-env slice, no reconcile — the app supervises itself.

## Requirements / Acceptance criteria

- [ ] **AC1** `menu/infrastructure/inventory/catalog.json`: add global
      `environments.poker = {"scenario":"vanilla"}`.
- [ ] **AC2** Same file, on the **`hp-zbook-17-g2`** machine leg:
      `environments.poker.poker = { "title": "🃏 Poker", "tailscale":
      "http://hp-zbook-17-g2:64100", "fqdn": "https://poker.imre.dev",
      "health": { "path": "/api/health" } }` (no `access` key unless the existing convention
      requires it for a CF-fronted app — check offtube's entry and match it).
- [ ] **AC3** `menu/infrastructure/inventory/apps.json`: add `apps.poker` in the offtube shape —
      `namespace/sliceUnit/workflow/envFile/portBand: null`,
      `deploy { "scheme":"watch", "supervisor":"self", "processManager":"pm2",
      "unit":"poker.service" }`, one service `{ title, role:"app", domainBearing:true,
      health:{path:"/api/health"}, access:"cloudflare" }`, `kind:"app"`; and add
      `environments.poker = "poker"`.
- [ ] **AC4** `cd ~/dev/menu && npm run test:scripts` — the descriptor guard
      (`infrastructure/tests/app-descriptor.test.js`) **stays green and unmodified**. If it fails,
      fix the data, never the guard.
- [ ] **AC5** Dashboard unit suite green; `regen-*-check` (if any generator artifact moves) clean.
- [ ] **AC6** Restart the dashboard
      (`PM2_HOME=/home/imre/.pm2-dashboard node_modules/.bin/pm2 restart menu-dashboard`) and verify
      the **live Fleet page** renders the `poker` group with a green probe.
- [ ] **AC7** Commit scoped to this ticket; push **`newMaster`** with
      `GIT_SSH_COMMAND="SSH_AUTH_SOCK= ssh -F /dev/null -i ~/.ssh/id_ed25519" git push`.
- [ ] **AC8** Note in the ticket what is **not** covered: non-menu ports are not auto-reserved
      (64100 is a hand-picked verified-free port), and credential resolution order (INFRA-137g
      remainder) does not apply because the app owns its own `.cloudflared/` secrets.

## Tests

```bash
cd ~/dev/menu && npm run test:scripts        # guard + fleet script suites, hermetic
cd ~/dev/menu-dashboard && npm run test:unit
curl -s -o /dev/null -w '%{http_code}\n' https://poker.imre.dev/api/health
```

Serialised fleet runs only (INFRA-060 global lock) — never two fleet suites at once.

## Notes for the implementer

- Follow `apps.offtube` **exactly**; a near-miss shape is what the guard exists to catch.
- Keep `title` emoji consistent with the neighbours (`🎶 Entertainment Center`, `🏺 Earth & Fire`).
- The dashboard serves the **main checkout**; a branch is invisible to the user until merged and
  the service restarted.

## Done checklist

- [ ] AC1–AC8 ticked · guard + unit suites green · merged to `newMaster`, pushed
- [ ] Ticket moved to `tickets/done/` with `git mv`; `tickets/README.md` row updated
