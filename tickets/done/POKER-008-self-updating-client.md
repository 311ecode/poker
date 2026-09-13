# POKER-008 — a long-lived tab reloads itself when the app is redeployed

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — repeatedly confused by a tab that had been open across deploys and kept running
an old client (UUID member labels, hidden claim form, no vote dropdown), then asked *"am I using an
old session?"*
**Status:** **DONE** (2026-09-13) — landed on `main` (`f05f8b6`), pushed, live on
**https://poker.imre.dev** (`/api/health` carries the stamp).

## 0. Root cause

The client is plain ES modules fetched once per page load. A tab left open keeps its old JavaScript
forever — the WebSocket reconnects, but the page never reloads. Three rounds of "please hard-reload"
is not a fix.

## 1. Decision

**The app notices it has been superseded and reloads itself.**

- The server exposes a **build stamp** on `GET /api/health`: the newest mtime among the files in
  `public/`, so it changes on every client deploy (including the client-only pulls that do **not**
  restart PM2).
- The client records the build it booted with in `sessionStorage["poker.build"]` and re-checks
  `/api/health` (no-store) at boot, on window **focus**, on **visibilitychange**, and every 60 s.
- When the server's build differs, the client writes the new value and calls `location.reload()`.
  Because the new value is stored **before** reloading, the fresh page compares equal and cannot
  loop.
- Room/vote/name/own-ballot state is all server-side or in `localStorage`, so a reload is safe.
- A tab still running pre-POKER-008 code has no watchdog and still needs one manual reload; from
  then on it updates itself.

## 2. Acceptance criteria

- [x] AC1 — `GET /api/health` carries a non-empty `build` string that changes when a `public/` file
  changes (no PM2 restart needed; verified live with a `touch`).
- [x] AC2 — A booted client stores the build and does **not** reload while it is unchanged.
- [x] AC3 — When the server's build changes, the client reloads itself exactly once (proved with the
  `__pokerTest.checkBuild()` hook and a mutated `/api/health`).
- [x] AC4 — `npm test` green (113/113), `npm run test:e2e` green (23 passed, 3 live gated),
  `LIVE=1 npm run test:e2e:live` green (3/3) on the origin; ticket moved to `tickets/done/`.

## 3. Files

`server.ts` (`build` in `/api/health`), `public/app.js` (the watchdog + test hook),
`e2e/auto-update.spec.ts`, `test/http.test.ts`, this ticket.
