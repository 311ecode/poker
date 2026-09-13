# POKER-005 — claimed means done: the claim form is removed, no claim and no rename

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — *"I still can claim my name within a room… also if a name is claimed, no more
claims or renames."*
**Status:** **DONE** (2026-09-13) — landed on `main` (`e0d49dc`), pushed, live on
**https://poker.imre.dev** and verified there by the gated live smoke.

## 0. Root cause first

The pasted DOM is a **stale tab**: it renders `ul[data-options] > button[data-choice="a"]` and the
old `"2 / 2 voted"` tally, and has no `data-choice-select` — none of which the deployed
`public/app.js` can produce (it renders the POKER-004 `<select>`). That tab has been open since
before the POKER-002 deploy, so it never fetched the new client. One reload fixes it.

But the guarantee was also weaker than it should be: the form was only given the `hidden`
attribute. This ticket makes it structural.

## 1. Decision

- While a visitor is **in a room and named**, the claim form is **removed from the DOM** — not
  hidden — so there is no claim control, no rename control and no way to submit one.
- It is (re)inserted **only** when it is genuinely the path: in a room, unnamed, with no stored name
  (or a stored name this room refused as taken).
- **Server stays strict**: an already-named session cannot rename (`name_locked`); a same-name
  "claim" remains an idempotent no-op purely so two tabs of one browser cannot trip over each other.
- The POKER-003 auto-claim is unchanged: a named session is never asked, and never re-claims.

## 2. Acceptance criteria

- [x] AC1 — In a room with a claimed name, `[data-form="claim"]` has **count 0** (detached), both
  after the claim and after a reload; the e2e asserts the absence, not just non-visibility.
- [x] AC2 — The form is present and visible only in a room, unnamed, with no stored name (or after a
  stored name was refused here) — the POKER-002/003 paths keep working.
- [x] AC3 — The server still refuses a rename with `name_locked` (unit test), and never changes a
  name on a repeat claim.
- [x] AC4 — `npm test` green (112/112), `npm run test:e2e` green (19 passed, 3 live gated),
  `LIVE=1 npm run test:e2e:live` green (3/3) on the origin; ticket moved to `tickets/done/`.

## 3. Files

`public/index.html` (claim slot), `public/app.js` (`renderChrome` detach/attach),
`e2e/name-claim.spec.ts` + `e2e/live-smoke.spec.ts` (absence assertions), this ticket.
