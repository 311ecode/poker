# POKER-018 — the socket goes silent, and the tunnel drops it (the connect/disconnect dance)

**Project:** poker (main) · **Created:** 2026-09-14
**Reporter:** user, from a virgin machine on the deployed origin — *"connect disconnect connect
disconnect dance"*.
**Status:** **DONE** (see §4).
**Severity:** user-visible on every quiet room; also caused pointless churn in presence.

## 1. Reproduced, with the clock

A fresh browser, live origin, one room, nothing else happening for 150s:

```
connection transitions:  0.5s open  →  125.6s closed  →  125.9s connecting  →  126.0s open
websocket events:        0.4s open wss://poker.imre.dev/ws | 125.5s close | 125.8s open
```

Every ~2 minutes, forever. Not a server fault: `pm2 describe poker` showed `uptime 2h`,
`unstable restarts 0`, and five `/api/health` polls 2s apart were flat (`connections 6`).

## 2. Root cause

The frozen contract defines a JSON keepalive (POKER-001 §1.4, `{"t":"ping"}` → `{"t":"pong"}`):

- `server.ts` has always answered it (`case "ping": peer.send({t:"pong"})`);
- `lib/ws.ts` has a `ping()` frame writer;
- `public/app.js` even has a `case "pong"` handler —

…and **nothing ever sent a ping**. A quiet room (nobody casting) therefore carried *zero* traffic, and
the Cloudflare tunnel closes an idle WebSocket at ~100–125s. The client's `onclose` reconnected 250ms
later, went quiet again, and was dropped again. The dance is the proxy's idle timer, not our code.

## 3. Fix

`public/heartbeat.js` — a small, timer-injectable state machine wired into the socket lifecycle:

- sends `{"t":"ping"}` every **25s** (well inside the proxy's ~100s idle cut) — the contract's own
  frame, so there is no protocol change and no server change;
- `touch()` on **every** inbound frame, so the pong (or a vote broadcast) is what proves liveness;
- if nothing at all arrives for **65s**, the link is declared dead and the socket is closed — the
  ordinary close handler reconnects. This also catches the half-open case a browser cannot see on its
  own (a dropped tunnel sends no close frame);
- started on `open`, stopped on `close` and in `closeSocket()` (which nulls `socket` first, so the
  close handler bails — the timer would otherwise outlive the socket).

## 4. Acceptance criteria

- [x] AC1 — the client sends the contract's `{"t":"ping"}` on a live socket, and the server's `pong`
      comes back. **Verified live after deploy:** a 150s quiet room held ONE socket, no close.
- [x] AC2 — a link with no inbound traffic is declared dead within two intervals and recovered
      (falsified in the unit test: without `touch()` the heartbeat fires `onDead` exactly once).
- [x] AC3 — `test/heartbeat.test.ts`: 5 tests on a fake clock (interval, touch-keeps-alive, the
      falsification, idempotent `stop()`, `send` required). `npm test` → **122 / 122**.
- [x] AC4 — `e2e/heartbeat.spec.ts` drives the page clock so the 25s ping is asserted in <1s, and
      asserts the `pong` came back and the socket was never dropped.
- [x] AC5 — no protocol, server or schema change: the frozen contract already specified this frame.

## 5. Files

`public/heartbeat.js` (new) · `public/app.js` · `test/heartbeat.test.ts` (new) ·
`e2e/heartbeat.spec.ts` (new) · this ticket.

## 6. Verification (deployed origin, 2026-09-14)

| Check | Result |
|---|---|
| `npm test` | **122 passed / 0 failed** |
| `npm run test:e2e` | **39 passed / 3 skipped (gated live smoke) / 0 failed** |
| Live, 150s quiet room | **one socket, 0 closes, 5 pings / 5 pongs, `[data-connection]` never left `open`** (before: closed at 125.5s and reopened) |

The live run is the falsification that matters: the same probe that caught the dance
(`0.5s open → 125.6s closed → 125.9s connecting → 126.0s open`) now reports a single
`0.8s open` transition for the whole 150s window.
