# POKER-004 — the vote value is a select, sent the moment it changes

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — *"I shall not be able to claim name … [I] shall choose from a select the values,
and as I change it shall be sent immediately."* Clarified: **only the vote value** becomes a select;
**names are not selected** — the name is written once on the page, then it is done, it cannot be
changed, and it is bound to that browser.
**Status:** IN PROGRESS

## 0. Decision

- The 8 deck **buttons** become **one `<select>`** whose options are the fixed deck
  `0, 0.5, 1, 2, 3, 5, 8, 13`, each labelled with its **live count** (`3 (2)`).
- **Changing the select casts the vote immediately** — no button, no submit. First change sends
  `vote_cast`, a later one `vote_change` (the POKER-002 round-2 path).
- The select shows **my own current value** (the POKER-002 localStorage mirror) and is **disabled**
  while the vote is closed or while the viewer is unnamed. "Your vote: X" stays.
- **Name flow is untouched** (POKER-002/003): typed once, `name_required` until claimed, locked
  per room, remembered in the browser and reused automatically.
- **Anonymity (R1–R7) is untouched**: counts only while open, no per-person choice on the wire.

## 1. Acceptance criteria

- [ ] AC1 — Each vote card renders `select[data-choice-select]` with exactly the 8 deck options in
  order, each option carrying `data-choice`, `data-count` and the label `"<value> (<count>)"`.
- [ ] AC2 — Selecting a value on the real browser fires **no** extra click/submit: the `change`
  event alone sends `vote_cast` (first) / `vote_change` (later) and the count updates.
- [ ] AC3 — The select is `disabled` while the viewer is unnamed or the vote is closed, and enabled
  for a named viewer on an open vote.
- [ ] AC4 — The select's value is my own ballot: it survives a close→reopen and a page reload, and
  the "Your vote: X" line still reads it (`data-your-choice`).
- [ ] AC5 — `npm test` + `npm run test:e2e` green (serialised), live smoke green on
  `poker.imre.dev`; ticket moved to `tickets/done/`.

## 2. Files

`public/app.js` (vote card + `change` handler), `public/style.css` (select styling),
`e2e/helpers.ts` (`castVote` → `selectOption`), the specs that asserted the buttons
(`vote-identity`, `vote-realtime`, `live-smoke`), plus this ticket.
