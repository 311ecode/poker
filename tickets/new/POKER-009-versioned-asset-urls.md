# POKER-009 — build-stamped module URLs so a CDN-cached app.js cannot go stale

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — kept seeing a mixed client (POKER-007 `index.html`, pre-POKER-006 `app.js`) even
after reloading; asked *"am I using an old session?"*
**Status:** IN PROGRESS

## 0. Root cause (measured, not guessed)

```
GET https://poker.imre.dev/app.js   -> cache-control: max-age=14400   cf-cache-status: EXPIRED
GET https://poker.imre.dev/         -> cache-control: no-cache        cf-cache-status: DYNAMIC
```

Cloudflare caches `.js`/`.css` by extension and the zone's **Browser Cache TTL** rewrites the
origin's `Cache-Control: no-cache` to `max-age=14400` (4 h). `index.html` is not cached. Every reload
therefore pairs a fresh HTML with a **stale `app.js` (and its modules)** — the mixed client. A hard
reload cannot fix an edge-cached URL.

## 1. Decision

**Make every asset URL build-specific**, so a cached copy can never be the wrong version:

- The origin already computes a build stamp (POKER-008: newest mtime in `public/`).
- When serving `index.html`, the server rewrites `./app.js` and `./style.css` to
  `./app.js?v=<build>` / `./style.css?v=<build>`.
- When serving any `.js`, the server rewrites relative module specifiers
  (`from "./store.js"`, `import "./leakguard.js"`, …) to carry the same `?v=<build>`.
- A new build is a new URL, so the CDN and the browser both miss and fetch the current file. Caching
  the old URL for hours is then harmless.
- `Cache-Control: no-cache` stays on the origin; `index.html` remains uncached. No Cloudflare
  account/zone change is needed.

This is a serving-time rewrite, not a bundler: sources stay plain ES modules and `node server.ts`
still runs them with no build step.

## 2. Acceptance criteria

- [ ] AC1 — `GET /` returns HTML whose script/style URLs carry `?v=<build>` matching
  `/api/health`'s `build`.
- [ ] AC2 — `GET /app.js` rewrites every relative import to `?v=<build>` (and `/store.js?v=<build>`
  is served with the right content type).
- [ ] AC3 — The build stamp changes on a client-only deploy, so the versioned URL changes too.
- [ ] AC4 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to `tickets/done/`.

## 3. Files

`server.ts` (versioned rewrite in `serveStatic`), `test/http.test.ts`, `e2e/client-shell.spec.ts`,
this ticket.
