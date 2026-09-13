# POKER-001 — poker.imre.dev: a no-auth, realtime voting room app (parent · coordination + frozen contract)

**Project:** **poker** — this repo (`git@github.com:311ecode/poker.git`, branch `main`), a
standalone sibling app like `earthandfire` and `offtube`. **Not** dashboard work: no `DASH-…`,
no `menu-ctl.sh`, no reconcile. Tickets are **`POKER-…`**, in this repo's `tickets/`.
**Status:** **PLANNED** (2026-09-13) — design agreed with the user, **no code yet**. This parent is
the contract + coordination map; the work is **six parallel sub-tickets** (001a–001f).
**Created:** 2026-09-13
**Reporter:** user — *"we want to create the poker.imre.dev … realtime communication … create a
room, find the rooms, myrooms are the rooms I have visited on the browser ordered by the last visit
time … e2e tests, similar deployment like music.imre.dev, PM2 based magic … a user logs in and new
requested for the name, we want matrix style big letters … we do show how voted … anyone can start a
new voting … we can get back to vote history … anyone can close and reopen votes … when we have open
vote names are not visible in each and every screen, the order of the voters are random, each person
is the last one … no authentication … make sure you can functionally test it easily … some
playwright magic from zero … database is multiple json file per room one json … LGPL."*

---

## 0. Decisions already made (do not re-litigate)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Deploy on `hp-zbook-17-g2`**, like music.imre.dev | g2 owns the imre.dev tunnels + PM2 daemons; user chose it. |
| 2 | **No authentication at all** — no Cloudflare Access, no login | Hard requirement. A deliberate difference from offtube, which has an email allowlist. |
| 3 | **Optional per-room passcode** is the only privacy lever | Agreed with the user. |
| 4 | Identity = anonymous session id in `localStorage`, name claimed per room | No auth, but names must be unique per room and survive reload. |
| 5 | **One JSON file per room** — the room file is the whole database | User's explicit choice. No journal, no DB, no index, no event log. |
| 6 | Realtime = **WebSocket**, one PM2 process (`instances: 1`) | Realtime push is the feature; in-memory state means one instance. |
| 7 | e2e = **Playwright from zero**, multi-context, spawned server on a random free port | "functionally test it easily … playwright magic from zero". |
| 8 | **Node 26.8.1** (nvm) — the fleet's canonical toolchain node (`catalog.json` → `toolchain.node`), present on the z640 and on g2 | Node ≥ 24 type-stripping lets `node server.ts` run with **no build step**. |
| 9 | **SSPL-1.0** (Server Side Public License v1) — © Imre Toth | User decision, explicitly aggressive: third parties may **use it internally** and self-host freely, but **offering it as a service** obliges them to release the whole stack (LICENSE §13). Accepted cost: **not OSI-approved**; some orgs/distros refuse SSPL as policy. |

**Out of scope:** real poker rules/gameplay, accounts, chat, a real DB, multi-host scaling,
Cloudflare Access. The `poker` name is the *theme*; the feature is the voting room.

---

## 1. The frozen contract

**Frozen. Owned by 001a. Do not edit §1 from a sub-ticket.** The message shapes, the room-file
schema, the anonymity rules R1–R7 and the client keys in §1.7 are the interface every slice codes
against; a change is a `001a` amendment **plus a message to every consumer**, never a silent edit.
All sub-tickets build against this section.

### 1.1 Database: one JSON file per room

```
data/rooms/<CODE>.json          # ONE file per room holds EVERYTHING for that room
```

```jsonc
{
  "code": "F4K2QH",                    // 6 chars, uppercase, no ambiguous glyphs
  "title": "Friday night",
  "public": true,
  "passcodeHash": null,                // never the passcode
  "createdAt": 1757800000000,
  "members": [
    { "session": "s-8f2a…", "name": "Alice", "joinedAt": 1757800001000, "lastSeenAt": 1757800500000 }
  ],
  "votes": [                            // history IS this array; order = creation order
    {
      "id": "v1",
      "title": "Who pays the tab?",
      "options": ["Bob", "Alice", "Split"],
      "state": "open",                  // "open" | "closed"
      "createdAt": 1757800100000,
      "closedAt": null,
      "events": [
        { "at": 1757800100000, "kind": "opened",   "by": "s-8f2a" },
        { "at": 1757800400000, "kind": "closed",   "by": "s-7711" },
        { "at": 1757800500000, "kind": "reopened", "by": "s-8f2a" }
      ],
      "ballots": [                      // one per session; last write wins while open
        { "session": "s-8f2a", "choice": "Split", "at": 1757800200000 }
      ]
    }
  ]
}
```

**Write rules (001b):** one mutation = **one file write**; temp file + `rename()`; a per-room
promise lock serializes same-room writes while different rooms stay parallel; corruption fails
**loud**; derived values (counts, `votedCount`, per-viewer order) are **never persisted**;
**My Rooms is client-side** and never server state.

### 1.2 Anonymity + ordering rules (testable)

| Rule | Requirement |
|---|---|
| **R1** | While a vote is **open**, no client *receives* who voted what — only aggregate counts. |
| **R2** | While **open**, no member name is attached to a ballot on the wire. |
| **R3** | Voter display order is **per-viewer different** (seeded by viewer session + vote id). |
| **R4** | That order is **stable across re-renders** and places **self last**. |
| **R5** | On **close**, names + choices are revealed to everyone. |
| **R6** | **Reopen** re-hides names and resumes the same vote; `events` keeps both transitions. |
| **R7** | A name collision is rejected in realtime at claim time (first claim wins). |

### 1.3 WebSocket protocol (client → server)

```jsonc
{"t":"hello","room":"F4K2QH","session":"s-…","passcode":"…"}   // passcode optional
{"t":"claim","name":"Alice"}                 // → ok | name_taken
{"t":"vote_open","title":"…","options":["…","…"]}
{"t":"vote_cast","voteId":"v1","choice":"Split"}
{"t":"vote_change","voteId":"v1","choice":"Bob"}   // only while open
{"t":"vote_close","voteId":"v1"}                   // any member
{"t":"vote_reopen","voteId":"v1"}                  // any member
{"t":"room_create","title":"…","public":true,"passcode":"…"}
{"t":"room_list"}
{"t":"ping"}
```

### 1.4 Server → client

```jsonc
{"t":"hello_ok","you":{…},"room":{…},"state":{…}}
{"t":"error","code":"name_taken|bad_passcode|vote_closed|rate_limited|bad_message"}
{"t":"presence","members":[{"session":"…","name":"Alice","online":true}]}
{"t":"vote_new","vote":{"id":"v1","state":"open","counts":{…},"votedCount":0,"totalMembers":4}}
{"t":"vote_update","vote":{"id":"v1","counts":{"Split":1},"votedCount":1}}   // OPEN: counts ONLY
{"t":"vote_you","voteId":"v1","order":["s7","s2","s9"],"self":"s9"}          // self last
{"t":"vote_closed","vote":{"id":"v1","state":"closed","result":{…},"reveal":[{"name":"Carol","choice":"Bob"}]}}
{"t":"vote_reopened","vote":{"id":"v1","state":"open","counts":{…}}}
{"t":"history","votes":[ … ]}
{"t":"rooms","rooms":[{"code":"F4K2QH","title":"…","members":5,"hasPasscode":true}]}
```

**Hard invariant:** a `vote_update` emitted while `state=="open"` **must not contain** `name`,
`reveal`, `ballots` or per-person choices. Asserted on the wire (001c), not the DOM.

### 1.5 HTTP

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | app shell (`public/`) |
| `GET` | `/api/health` | `{ok:true,version,rooms,connections,uptime}` — catalog health path |
| `GET` | `/api/rooms` | public rooms (never passcode-protected ones) |
| `POST` | `/api/rooms` | create room |
| `GET` | `/api/rooms/:code` | room metadata (`hasPasscode`, never the passcode) |
| `GET` | `/api/rooms/:code/history` | votes incl. reveal for closed ones |

### 1.6 Boundaries (one writer per file, per slice)

| Path / area | Owner |
|---|---|
| `lib/asciiFont.ts` | **001e** |
| `lib/db.ts` | **001b** |
| `lib/rooms.ts`, `lib/votes.ts`, `server.ts` | **001a** |
| `public/**` | **001c** (shell + client JS) — 001e adds **only** the banner/markup call sites |
| `public/style.css` | **001e alone** |
| `e2e/**`, `playwright.config.ts` | **001c** |
| `ecosystem.config.cjs`, `scripts/**`, `systemd/**`, `.cloudflared/**` | **001d** |
| `tickets/**` in `menu` | **001f** |

**CSS rule (resolves the only overlap):** `001c` may use inline styles and `data-*` hooks but
**must not create or edit `public/style.css`** — put the unstyled markup plus a
`/* POKER-001e: style this */` marker in place. `001e` owns that file end to end, so the two
slices never conflict.

### 1.7 Client session + client-side state (contract — 001c implements, 001a accepts)

- **Session id:** generated **once per browser** as `"s-" + crypto.randomUUID()`, stored in
  `localStorage["poker.session"]`. Sent in every `hello`. It is the *only* identity; no auth.
- **Name:** kept in `localStorage["poker.name"]` (a convenience prefill only — authority is the
  server's `members[].name` for the room).
- **My Rooms:** `localStorage["poker.myrooms"]` = `[{ code, lastVisitAt }, …]`, updated on every
  room visit and rendered **most-recent-first**. Never sent to the server; the server must not grow
  a "recent rooms" endpoint.
- **Last room:** `localStorage["poker.lastRoom"]` (optional convenience deep-link).

### 1.8 Transport decision (settled — 001a implements)

**Hand-rolled WebSocket over `node:http`'s `upgrade` event — zero runtime dependencies**, matching
offtube (its `package.json` has **no** `dependencies`; only `@playwright/test` and `pm2` as dev
deps). Implement RFC 6455 framing for the subset used here: text frames, ping/pong, close,
payload lengths 7-bit/16-bit/64-bit, and **masked client→server frames** (unmasking is required).
Do **not** add `ws` — if framing turns out to be a real time sink, that is a 001a decision to
escalate, not a silent dependency add.

### 1.9 Reference assets to copy and adapt (read these before writing anything)

All paths are in **`~/dev/offtube`** (this machine) — the proven self-supervised deploy.

| Asset | Path | ~size | Use for |
|---|---|---|---|
| PM2 definition | `ecosystem.config.cjs` | 49 L | 001d `ecosystem.config.cjs` |
| PM2 boot script | `scripts/pm2-start.sh` | 22 L | 001d (nvm PATH pin — **change `v24.15.0` → `v26.8.1`**) |
| Keeper unit | `systemd/offtube.service` | 37 L | 001d `systemd/poker.service` |
| Tunnel unit | `systemd/cloudflared.service` | 20 L | 001d (not a PM2 app) |
| Tunnel/DNS script | `scripts/setup-cloudflare.mjs` | 656 L | 001d `scripts/setup-cloudflare.mjs` — **delete the Access-app block** (decision 2) |
| Tunnel library | `lib/cloudflare.ts` | 374 L | 001d token/tunnel/ingress/CNAME helpers |
| Playwright config | `playwright.config.ts` | 50 L | 001c (random-port + webServer pattern) |
| E2E helpers | `e2e/helpers.ts` | — | 001c style reference |
| Server shape | `server.ts` | — | 001a structure/naming reference (no build step, `node server.ts`) |

### 1.10 Worktrees, branches, test ports (the fan-out mechanics)

- Worktree: `git worktree add ~/dev/poker-<letter>-work -b poker/<letter>-<slug>` from
  `~/dev/poker` — so **`~/dev/poker-a-work` … `~/dev/poker-f-work`** (one letter, matching the
  sub-ticket; the earlier `poker-aa-work` style was a typo).
- Each slice runs its own e2e on a **port it discovers itself** (`net.listen(0)`); never a shared
  fixed port, never 64100 (that is the g2 tunnel origin only).
- Each slice uses its own `DATA_DIR` (a fresh temp dir) so parallel suites never share room files.
- On landing: merge to `main` here, remove the worktree, delete the branch, then close the ticket —
  one landing at a time, never batched (per `~/dev/agent.md`).

---

## 2. Parallel plan — six sub-tickets

`001a` is the **spine**. `001b` is split out because the user's "one JSON per room" choice is the
only concurrency-critical piece. `c`/`d`/`e` consume the frozen contract above and run in parallel
the moment `a` lands a protocol stub. `001f` is gated on `d` being live.

| Sub | Title | Repo | Depends on | Parallel with |
|---|---|---|---|---|
| **[001a](../done/POKER-001a-server-protocol-core.md)** | server core: HTTP + WS protocol, rooms, votes, name claims | poker | — (spine) | — |
| **[001b](../done/POKER-001b-room-file-db.md)** | the database: one JSON file per room, atomic + serialized writes | poker | contract §1.1 | a, c, d, e |
| **[001c](POKER-001c-browser-client-e2e.md)** | browser client + Playwright from zero, multi-context realtime e2e | poker | a (protocol stub) | b, d, e |
| **[001d](POKER-001d-deploy-g2-pm2-tunnel.md)** | deploy on g2: PM2 + systemd keeper + Cloudflare tunnel | poker | a | b, c, e |
| **[001e](POKER-001e-ascii-ui.md)** | Matrix-style ASCII banner font + screens + theme | poker | a (protocol stub) | b, c, d |
| **[001f](POKER-001f-fleet-descriptor-catalog.md)** | fleet descriptor + catalog onboarding (menu repo) | menu | d live | — |

**Coordination (per `~/dev/agent.md` and this repo's `AGENTS.md`):**
- One sub-ticket = one git worktree (`~/dev/poker-a-work`, `…-b-work`, …), own branch, own test port.
  **Subagents never write this main checkout.**
- The coordinator reviews the **diff**, runs the tests **itself**, lands each slice immediately —
  never batching finished branches.
- `001a` freezes §1 **before** `c`/`d`/`e` start; a later contract change is a `001a` change plus a
  message to every consumer, never a silent edit.
- Each worktree's e2e picks its own free port via `net.listen(0)`; no shared fixed port.
- On g2 the tunnel origin is **64100** — verify free with `ss -tlnp` before `001d` binds it.

---

## 3. End-to-end acceptance (the parent is done when ALL of these hold)

- [ ] `https://poker.imre.dev/api/health` → 200; PM2 `poker` online under `poker.service`,
      recovered after `kill -9` (**001d**).
- [ ] No authentication anywhere; no Access app; public origin robust to malformed input (**001d**).
- [ ] Name claimed with no account; **duplicate rejected in realtime** (**001a/001c**).
- [ ] Room create + find; a passcode-protected room rejects a wrong passcode and never leaks it
      (**001a/001b**).
- [ ] **My Rooms** = rooms this browser visited, **most-recent first**, survives reload (**001c**).
- [ ] Any member can open a vote; it is **pushed** to every member without reload (**001a/001c**).
- [ ] While open, **no client receives names/choices** (R1/R2), asserted on the wire (**001c**).
- [ ] Voter order is per-viewer random, **stable**, **self last** (R3/R4) (**001e** + tests).
- [ ] Close → reveal with the big-letter moment; reopen → names hidden, same vote (R5/R6); history
      reachable (**001a/001c/001e**).
- [ ] **One JSON file per room**: mutating a room writes exactly that room's file, atomically, and
      two rooms write concurrently without interference (**001b**).
- [ ] ASCII banner renders equal-width for the enumerated strings; no clipped glyph; mobile
      fallback (**001e**).
- [ ] `npm test` green; `npm run test:e2e` green with **two browser contexts** (**001c**).
- [ ] Fleet dashboard shows the `poker` group; `menu` guard + dashboard unit suites green (**001f**).
- [ ] LICENSE present and **verbatim** (**001a**); `COPYRIGHT` holds the © line; `RESTRICTIONS.md`
      is the plain-English summary; `package.json` declares `"license": "SSPL-1.0"`.

## 4. Tests

```bash
npm test               # unit (node --test)
npm run test:e2e       # Playwright, spawned server, random free port, isolated DATA_DIR
LIVE=1 npm run test:e2e:live   # gated smoke against the deployed origin
```

E2E must use **two independent browser contexts** in one room and assert the **WebSocket frames**
for the anonymity rules, not only what is painted.

### 4.1 The testing bar (applies to every sub-ticket)

This app is small, but two of its properties are invisible to the eye and easy to break silently:
**who knows what while a vote is open**, and **whether two writes landed cleanly**. Both are only
ever proven by tests. So the bar is not "tests pass" — it is that the tests would *catch the bug*:

1. **A test that cannot fail is not a test.** Before claiming any invariant is covered, **falsify
   it**: introduce the defect deliberately, watch the test go red, then remove it. Required at
   minimum for — the open-vote leak (make the server send `reveal` while open → `001c` must fail),
   the one-file-write rule (write another room's file → `001b` must fail), atomicity (skip the
   `rename` → `001b` must fail), and the ASCII cell width (shrink it by one → `001e` must fail).
   Record the falsification in the ticket.
2. **Assert the wire, not the pixels — for anything about secrecy.** The anonymity rules R1/R2 are
   about what a client *receives*. A DOM-only test passes while the payload leaks the names. Record
   the frames the second context receives and assert no frame carries `name`/`reveal`/`ballots`
   while a vote is open.
3. **Two real contexts for anything realtime.** Fan-out, the name-collision race and the
   per-viewer ordering are properties *between* clients. Two `browser.newContext()` contexts in one
   spec against one real server — no mocked socket, no single-page simulation.
4. **Race the races.** `001b`'s per-room write lock and `001a`'s name claim must be exercised with
   **genuine concurrency** (N simultaneous requests), not sequential calls that trivially pass.
5. **Test the failure paths, not just the happy ones.** Malformed frame, oversize message, bad
   passcode, cast on a closed vote, corrupt room file, unknown room. `001d` requires the public
   origin to stay robust — that is only credible if something tried to break it.
6. **Isolate by default.** Every spec gets a fresh temp `DATA_DIR` and a port it discovers itself
   (`net.listen(0)`); suites run serialised. A test that depends on ordering or a shared port is a
   future red, and this repo has no room for flaky.
7. **The e2e suite is the gate for the feature, not a nicety.** `npm test` alone does not close a
   sub-ticket: realtime, anonymity and reveal are proven end-to-end or they are not done. Do not
   `test.skip` an inconvenient spec — file a ticket for the gap instead.
8. **Hook semantics, not prose.** Expose `data-*` attributes (vote state, voter session, my-rooms)
   and assert those; never scrape rendered sentences, and never assert the ASCII banner's pixels in
   an e2e spec (`001e` unit-tests the font; e2e tests behaviour).

Each sub-ticket lists its own concrete cases in its `## Tests` section. Those lists are the
minimum, not the target.

## 5. Open items

**Blocking:** none. (Was **[B1]** — the GitHub repo; resolved 2026-09-13, see below.)

**Non-blocking:**
1. **[N1] `instances: 1` is mandatory** (in-memory room state). The single-process ceiling is
   accepted, not a defect to fix later.

**Resolved (2026-09-13):**
- **[B1] `311ecode/poker` exists and `main` is pushed.** Created via the API (private, no
  auto-init), `origin` = `git@github.com:311ecode/poker.git`, `main` tracks `origin/main`, and the
  verbatim `LICENSE` was verified byte-identical on the remote. `001a` AC1 is **no longer blocked**;
  a fresh agent can clone or `git worktree` straight away.
- **License:** **SSPL-1.0**, © Imre Toth — `LICENSE` (verbatim), `COPYRIGHT`, `RESTRICTIONS.md` and
  the SPDX field are all landed. The earlier "LGPL" placeholder is dead; do not resurrect it.

## Done checklist

- [ ] All six sub-tickets landed (AC in each), each pushed, each moved to `tickets/done/`
- [ ] This parent's §3 verified **against the live origin**
- [ ] Parent moved to `tickets/done/`
