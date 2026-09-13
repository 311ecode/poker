# POKER-001c — poker: browser client + Playwright-from-zero (multi-context realtime e2e)

**Reporter:** user — *"make sure you can functionally test it easily … some playwright magic from
zero … myrooms are the rooms I have visited on the browser ordered by the last visit time."*
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md) — protocol §1.3/§1.4 frozen.
**Repo:** `311ecode/poker` (worktree `~/dev/poker-c-work`, own branch).
**Depends on:** 182a landing the protocol stub (`/api/health` + a `hello`/`echo` WS round-trip).
**Parallel with:** 182b, 182d, 182e.

## Summary

The browser app: a dependency-free ES-module client in `public/` that owns the WebSocket, room
navigation, the My-Rooms store, and every user-visible flow (name claim, rooms, voting, reveal,
history). Plus the **functional test harness from zero**: Playwright with a spawned server on a
random free port and an isolated `DATA_DIR`, driven with **two browser contexts** so realtime
fan-out and the anonymity rules are tested for real, not simulated.

## Requirements / Acceptance criteria

- [ ] **AC1** `playwright.config.ts` copied in spirit from offtube: **one random free port per run**
      via `net.listen(0)` shared through an env var (Playwright evaluates the config more than
      once), `webServer: { command: "node server.ts", reuseExistingServer: false }`, `workers: 1`,
      repo-local `.pw-browsers`.
- [ ] **AC2** Each spec run gets an **isolated data dir** (`DATA_DIR` = a fresh temp dir, passed to
      the spawned server) so specs never see each other's rooms — `npm run test:e2e` is repeatable
      and order-independent.
- [ ] **AC3** Client connects and joins a room; **name claim** works; a **duplicate name is rejected
      in realtime** (context B tries the name context A holds) and the UI shows why.
- [ ] **AC4** **Rooms:** create a room; `Find rooms` lists public rooms; joining a
      passcode-protected room with a wrong passcode is refused with a visible message.
- [ ] **AC5** **My Rooms** — rooms this browser visited, **most-recent first**, persisted in
      `localStorage`, and the order changes after visiting another room; survives a reload. A test
      asserts the ordering *and* that the server holds no per-browser history.
- [ ] **AC6** **Realtime fan-out:** a vote opened in context A appears in context B **without a
      reload** (assert via WS frame + DOM).
- [ ] **AC7** **Anonymity on the wire (R1/R2):** a test records the frames received by context B
      while the vote is open and asserts **no frame contains** a `name`, `reveal`, `ballots` or
      per-person choice; only counts and `votedCount`.
- [ ] **AC8** **Ordering (R3/R4):** the voter list order differs between the two contexts, is
      **stable across a re-render/refresh**, and **each context sees itself last**.
- [ ] **AC9** **Close → reveal:** after close, both contexts see names + choices; **reopen** hides
      them again and voting resumes on the same vote; **history** shows the vote with its
      open/close/reopen events (R5/R6).
- [ ] **AC10** Malformed/oversize WS payload and a bad JSON body do not break the page (error UI,
      connection recovers).
- [ ] **AC11** `public/` is served with `Cache-Control: no-cache` and the client has **no build
      step** (plain ES modules), matching the fleet's no-bundler posture.
- [ ] **AC12** `LIVE=1 npm run test:e2e:live` runs a small smoke spec against
      `https://poker.imre.dev` (health + create-room + name claim), gated so it never runs by
      default.

## Tests

```bash
npm test                 # unit (client-state helpers, My-Rooms store)
npm run test:e2e         # Playwright, 2 contexts
LIVE=1 npm run test:e2e:live
```

- The **two-context** specs are the heart: `e2e/vote-realtime.spec.ts`,
  `e2e/anonymity.spec.ts`, `e2e/my-rooms.spec.ts`, `e2e/name-claim.spec.ts`.
- Add a `data-*` hook convention early (e.g. `data-vote-state`, `data-voter-session`,
  `data-my-rooms`) so specs never scrape prose.
- **Do not** assert the ASCII banner's pixels here — 182e owns that; assert semantics via `data-*`.

## Notes for the implementer

- Copy offtube's `playwright.config.ts` shape and its `e2e/helpers.ts` idea; the service-worker
  block is irrelevant here (no SW), but keep `workers: 1` and per-spec isolation.
- Multi-context: `browser.newContext()` twice; two contexts in one test cannot share
  `localStorage`, which is exactly why the My-Rooms test must run per-context.
- The client is the only place that writes `localStorage["poker.myrooms"]`; the server must never
  grow a "recent rooms" endpoint.
- Session/name/My-Rooms keys and the session id format are frozen in parent §1.7 — use them
  verbatim so 001a and the e2e helpers agree.
- **Do not create or edit `public/style.css`** (parent §1.6): leave markup + a
  `/* POKER-001e: style this */` marker. That is the one shared file between 001c and 001e.

## Done checklist

- [ ] AC1–AC12 ticked · `npm test` + `npm run test:e2e` green · worktree removed, merged, pushed
- [ ] Ticket moved to `tickets/done/` with `git mv`
