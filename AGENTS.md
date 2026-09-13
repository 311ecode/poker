# AGENTS.md — poker (poker.imre.dev)

**poker** is a small, standalone **realtime voting-room** app for a poker night: no authentication,
rooms, live votes, Matrix-style ASCII lettering. It is a **first-class member of the fleet** — it
runs self-supervised on `hp-zbook-17-g2` (like `offtube`/music.imre.dev), is published through its
own Cloudflare tunnel at **https://poker.imre.dev**, and is registered in the fleet inventory so
the dashboard shows it.

**Voting contract (POKER-002/004):** every vote uses the **one server-owned deck — `0, 0.5, 1, 2, 3,
5, 8, 13`**; `vote_open` carries only a title and a client-supplied `options` list is ignored. The
value is chosen from **one `<select>`** (`data-choice-select`) and **sent the moment it changes** —
there is no cast button; first change is `vote_cast`, later ones `vote_change`. An **empty question is
auto-numbered per room** — `Vote 1`, `Vote 2`, … derived from the vote id counter (POKER-010); a
typed title wins. A **claimed name is mandatory** for
`vote_open`/`vote_cast`/`vote_change`/`vote_close`/`vote_reopen` and is **permanent per room**
(`name_required` / `name_locked`); re-claiming the same name is idempotent. The viewer's own ballot
is remembered **client-side only** (localStorage per room) — never echo a per-person choice on the
wire.

**Name lifetime (POKER-003/005):** the claimed name is **burned into the browser** (`localStorage
poker.name`) and reused automatically; in a room the server already knows this session in, the
client sends **no `claim` frame at all**, and once a name exists the claim form is **removed from
the DOM** (`public/app.js` `renderChrome` detaches it) — no claim, no rename. It is re-inserted only
in a room, unnamed, with no stored name (or a stored name this room refused, e.g. `name_taken`).

**Self-updating client (POKER-008):** `GET /api/health` carries a `build` stamp (the newest mtime in
`public/`, so it changes on a client-only deploy without a PM2 restart). The client compares it and
**reloads itself** when it changes, so a tab left open across a deploy cannot keep running a
superseded client. Do not remove the stamp: stale tabs are otherwise invisible to the server.

**Asset versioning (POKER-009):** the origin rewrites HTML/JS asset URLs with `?v=<build>`
(`versionAssetUrls` in `server.ts`). Cloudflare rewrites our `Cache-Control: no-cache` to
`max-age=14400` for `.js`/`.css`, so without the stamp a reload serves fresh `index.html` with stale
modules — the "mixed client" bug. Keep `public/` modules versioned; never serve them unversioned and
never remove the rewrite.

**Vote rendering (POKER-011):** the Open-a-vote form lives **below** `[data-votes]`, and
`renderVotes()` must preserve `scrollTop` and re-focus the vote `<select>` with `preventScroll` —
casting a vote never moves the page or steals focus. Opening a vote clears the question box, and
**only for the opener** (POKER-012) — never react to a `vote_new` broadcast by clearing input.

It is a **sibling project**, not dashboard work: **no `DASH-…` tickets, no `menu-ctl.sh`, no
reconcile, no per-env slice.** Work is tracked as **`POKER-…`** tickets in this repo.

> **Status: LIVE** at **https://poker.imre.dev**. The frozen contract (data schema, WebSocket
> protocol, anonymity rules) is [`tickets/done/POKER-001-realtime-voting-room-app.md`](tickets/done/POKER-001-realtime-voting-room-app.md).

## Neighborhood

I live in `~/dev/` with other projects — `menu`, `menu-dashboard` (`DASH-…` tickets), `offtube`,
`earthandfire`, `opencode`. Each folder is its own git repo with its own remote — **commit changes
to the repo they belong to, never mix repos in one commit.** This repo is
`git@github.com:311ecode/poker.git`, branch **`main`**. The fleet router is `~/dev/agent.md`
(`dev-meta`); the fleet descriptor/catalog lives in `menu/infrastructure/inventory/` — a change
there belongs to the **menu** repo, even when it is about poker (POKER-001f).

## Stack (verify, do not change)

- **Node 26.8.1** (nvm) — the fleet's canonical toolchain node (`menu/infrastructure/inventory/catalog.json`
  → `toolchain.node`), installed on the z640 and on g2. **No bundler, no build step:**
  `node server.ts` runs TypeScript by Node type-stripping (needs Node ≥ 24).
- **Server:** one `http.Server` that also owns the WebSocket upgrade, on **one port**. No
  framework (no Express).
- **Client:** plain ES modules in `public/`, served statically with `Cache-Control: no-cache`.
- **Database:** **one JSON file per room** — `data/rooms/<CODE>.json` (`POKER-001b`). No DB, no
  index, no event log. `data/` is gitignored; `DATA_DIR` overrides it (tests rely on this).
- **Tests:** `node --test` (unit) + **Playwright** (e2e). Browsers live in `./.pw-browsers`
  (gitignored) — the default `~/.cache` is not usable here.
- **License:** **SSPL-1.0** (Server Side Public License v1) — © Imre Toth. Deliberately *not*
  OSI-approved: internal use and self-hosting are unrestricted, but offering the functionality to
  third parties **as a service** obliges you to release the whole stack (LICENSE §13). See
  [`RESTRICTIONS.md`](RESTRICTIONS.md). `LICENSE` is verbatim and **must not be edited**; the
  copyright notice lives in `COPYRIGHT`.

## The one rule that must never break

**While a vote is open, no client may learn who voted what.** Counts and "N of M voted" only —
never a name, never a per-person choice, not in the DOM and **not on the wire**. Voter order is
per-viewer, stable across re-renders, and **self is always last**.

This is the product's entire point. A regression here is not a cosmetic bug. `POKER-001` §1.2
states the rules (R1–R7) and `001c` asserts them against the **WebSocket frames**, so a leak cannot
pass by only testing what is painted.

## Ticket workflow (mandatory)

- **Every request gets a ticket. Always.** Never implement without one.
- Tickets live in **`tickets/{new,done}/`** in **this** repo, named
  **`POKER-<NNN>-<kebab-slug>.md`** (sub-tickets: `POKER-001a-…`). `new/` = open, `done/` = landed
  **and pushed**.
- The parent ticket (`POKER-001`) owns the **frozen contract** and the coordination map; the six
  sub-tickets (`001a`–`001f`) are the work. Read the parent first — it replaces exploration.
- A ticket is **done** only when its acceptance criteria are ticked, its tests pass, and the work
  is **committed and pushed**. Then move it with `git mv` to `tickets/done/`.
- **Parallel slices:** one sub-ticket = one git worktree (`~/dev/poker-a-work`, …) + own branch +
  own test port. **Subagents never write this main checkout** — work lands here, and a second writer
  destroys untracked work. The coordinator reviews the diff, runs the tests itself, and lands each
  slice immediately (never batching).
- **Scale the ceremony to the change.** A wording fix does not need a fleet rollout; a protocol
  change touches every consumer.

## Getting around (once the code exists)

```bash
nvm use 26.8.1
npm ci --cache .npm-cache          # install (project-local cache)
npm test                           # node --test (unit)
npm run test:e2e                   # Playwright, random free port, isolated DATA_DIR
LIVE=1 npm run test:e2e:live       # gated smoke against https://poker.imre.dev

# runtime / ops (project-local PM2 — never the shared ~/.pm2)
PM2_HOME=/home/imre/dev/poker/.pm2 node_modules/.bin/pm2 list
PM2_HOME=/home/imre/dev/poker/.pm2 node_modules/.bin/pm2 logs poker
```

Run heavy Playwright suites **serialised** — parallel runs and port clashes are the usual false
red.

## Deploy / runtime (g2, self-supervised)

Same shape as `offtube`/`earthandfire`: **user systemd → PM2 → `node server.ts`**.

- **Keeper unit:** `systemd/poker.service` → `~/.config/systemd/user/poker.service`
  (`Type=forking`, `Restart=always`, `PIDFile=<repo>/.pm2/pm2.pid`), running
  `scripts/pm2-start.sh` (starts `ecosystem.config.cjs`, then `pm2 save`). PM2 state is
  **project-local** (`<repo>/.pm2`), never `~/.pm2`.
- **`instances: 1` is mandatory** — room state is in memory, so a second instance would serve a
  different world.
- **Cloudflare:** `node scripts/setup-cloudflare.mjs status|ensure [--dry-run]` creates the named
  tunnel `poker`, the ingress `poker.imre.dev → http://localhost:64100` (+ `http_status:404`), and
  a proxied CNAME in the `imre.dev` zone. Scoped token in `.cloudflared/api-token` (0600,
  gitignored); the creator token at **`/tmp/env/CLOUDFLARE_TOKEN_CREATOR` on g2** is used only to
  mint it and is never stored.
- **`cloudflared` is its own user unit** — `systemd/poker-cloudflared.service` →
  `~/.config/systemd/user/poker-cloudflared.service` — **not** a PM2 app, and deliberately **not**
  named `cloudflared.service`: on g2 that name is offtube's tunnel for music.imre.dev, and
  overwriting it takes that site down.
- **No Cloudflare Access app** — this app is deliberately unauthenticated (POKER-001 decision 2).
  Make zone changes through the script, never by hand-editing `~/.cloudflared/`.

## Git push (Tailscale SSH agent workaround)

Tailscale SSH provisions `~/.ssh/id_ed25519` but its agent refuses to sign outbound connections.
Always bypass it:

```bash
GIT_SSH_COMMAND="SSH_AUTH_SOCK= ssh -F /dev/null -i ~/.ssh/id_ed25519" git push
```

## Secrets

`.env` and `.cloudflared/` are **per-machine and gitignored** — never commit or print them. There
is **no auth** in this app by design, so keep anything sensitive out of the repo entirely rather
than relying on git-crypt.
