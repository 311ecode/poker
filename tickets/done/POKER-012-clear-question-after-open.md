# POKER-012 — the question box clears once the vote is opened

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"if we open a vote it will create a new vote and the text will disappear,
right? … the text should disappear from the open-new-vote text box or input."*
**Status:** **DONE** (2026-09-13) — landed on `main` (`2ecc054`), pushed, live on
**https://poker.imre.dev**.

## 0. Decision

- After a **successful** `vote_open` send, the client clears `[data-input="vote-title"]`, so the
  next vote starts from an empty box (the just-created vote keeps the typed title).
- The input gets `maxlength="80"` (the server's `MAX_TITLE_LENGTH`), so the optimistic clear cannot
  throw away a title the server would have rejected as too long.
- **Only the opener's box clears.** `vote_new` is broadcast to every member, so clearing on that
  frame would wipe a half-typed question out from under someone else — the clear is local to the
  submit, not a reaction to the broadcast.
- The clear happens when `send()` reports success (socket open); if the socket is down, the text is
  kept.

## 1. Acceptance criteria

- [x] AC1 — Typing a question and opening the vote creates a vote with that title **and leaves the
  question box empty**.
- [x] AC2 — Another member opening a vote does **not** clear this browser's half-typed question.
- [x] AC3 — The box is capped at 80 characters.
- [x] AC4 — `npm test` green (115/115), `npm run test:e2e` green (27 passed, 3 live gated),
  `LIVE=1 npm run test:e2e:live` green (3/3) on the origin; ticket moved to `tickets/done/`.

## 2. Files

`public/app.js` (open-vote submit), `public/index.html` (`maxlength`),
`e2e/vote-identity.spec.ts`, `e2e/live-smoke.spec.ts`, this ticket.
