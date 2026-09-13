# POKER-010 — an empty question auto-numbers the vote

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"it shall be new vote if no title added, shall be 001 002 etc… so what do you
think."* Confirmed format: **`Vote 1`, `Vote 2`, `Vote 3`**.
**Status:** **DONE** (2026-09-13) — landed on `main` (`1b2748a`), pushed, live on
**https://poker.imre.dev**.

## 0. Decision

- Opening a vote with an **empty/blank question** no longer errors: the **server** gives it the
  next per-room number, `Vote <n>`.
- `<n>` is the vote's own sequence number — the same counter that produces the id (`v1`, `v2`, …) —
  so titles are unique, sequential and stable per room, and never collide with a typed title.
- A **typed title still wins**; a title longer than 80 chars is still `bad_title`.
- The client hints it: the question input gets a placeholder and the hint says you may leave it
  empty.
- Server-side (not client-side) so it is atomic under the existing per-room write lock, and a
  client cannot create a blank title by sending nothing.

## 1. Acceptance criteria

- [x] AC1 — `vote_open` with a missing, empty or whitespace-only title creates a vote titled
  `Vote <n>` with id `v<n>`, incrementing per room (1, 2, 3 …).
- [x] AC2 — A typed title is used verbatim; 81 characters is still `bad_title`; a non-string title
  is still `bad_title`.
- [x] AC3 — The room's Open-a-vote form tells the user they may leave the question empty
  (`placeholder` + hint).
- [x] AC4 — `npm test` green (115/115), `npm run test:e2e` green (24 passed, 3 live gated),
  `LIVE=1 npm run test:e2e:live` green (3/3, including the auto-number check) on the origin; ticket
  moved to `tickets/done/`.

## 2. Files

`lib/votes.ts` (`applyOpenVote`), `public/index.html` (placeholder + hint),
`test/protocol.test.ts`, `e2e/vote-identity.spec.ts`, this ticket.
