# POKER-011 — Open-a-vote below the votes; voting must not move the page

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"the opening a new vote shall be at the bottom of all votes… also if the user
is voting [it] shall not jump to the top of the scroll; the scroller shall remain static."*
**Status:** IN PROGRESS

## 0. Decision

1. **Move the Open-a-vote form below the vote list** (inside the Votes section, after
   `[data-votes]`), so the newest vote sits right under the heading and the form is at the bottom.
   The empty-state text becomes "open one below".
2. **Voting must not move the page or lose the control.** Today `renderVotes()` does
   `replaceChildren(...)`, which destroys the focused `<select>`; focus falls to `<body>` and the
   browser can scroll. Fix, in `renderVotes()`:
   - capture `document.scrollingElement.scrollTop` (and `window.scrollY`) before the rebuild and
     restore it after, in the same task, so nothing paints in between;
   - if the focused control was a vote `<select>`, re-focus the rebuilt one with
     `focus({ preventScroll: true })`.
   - The same guard covers a server `vote_update` echo (the list is re-rendered twice per vote).

No protocol or server change.

## 1. Acceptance criteria

- [ ] AC1 — In the room, `[data-form="open-vote"]` follows `[data-votes]` in DOM order; the empty
  state says "open one below".
- [ ] AC2 — Casting a vote from a scrolled position leaves `window.scrollY` within a couple of
  pixels — the page does not jump to the top.
- [ ] AC3 — After casting, the vote's `<select>` is still the focused element (keyboard users keep
  their place).
- [ ] AC4 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to
  `tickets/done/`.

## 2. Files

`public/index.html` (form moved), `public/app.js` (`renderVotes` scroll/focus guard),
`e2e/scroll-stability.spec.ts`, this ticket.
