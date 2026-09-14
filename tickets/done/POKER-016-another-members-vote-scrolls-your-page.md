# POKER-016 — another member's vote scrolls your page (scroll anchoring)

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** coordinator, while verifying POKER-015 — user asked to *"check it on the playwright tests
or so and act accordingly"* before believing a flake claim.
**Status:** **DONE** (2026-09-13) — landed on `main` (`dc02664`), pushed.

## 0. How this started: a ~17% flake

`e2e/scroll-stability.spec.ts` (`POKER-011: voting from a scrolled position does not jump or lose
focus`) failed intermittently in **full-suite** runs, always at the same line:

```
Error: locator.scrollIntoViewIfNeeded: Element is not attached to the DOM
> await card.scrollIntoViewIfNeeded();
```

- **3 failures in 18 full-suite runs (~17%)**; passes **3/3 in isolation**.
- It **reproduced on the clean, pre-POKER-015 tree**, so it is **pre-existing**.

## 1. The flake was a symptom, not the bug

`renderVotes()` (`public/app.js`) rebuilds with `els.votes.replaceChildren(...cards)` — it **destroys
and recreates every card node** on the optimistic render, the server echo, and any broadcast.
`openVote()` returns on the optimistic render, so a later frame detaches the node Playwright holds.

Chasing that race deterministically — a second member opens a vote mid-interaction, guaranteeing the
rebuild — exposed a **genuine product bug**:

| scenario | scroll before | scroll after | delta |
| --- | --- | --- | --- |
| self-induced rebuild (POKER-011's own test) | 2388 | 2388 | **0** |
| **another member's vote** (forced rebuild) | 2388 | 2415 | **+27px** |

The shift is **persistent** (sampled over 1.2s; it never returns) and lands **~114ms** after the
broadcast — i.e. *after* `renderVotes()` already restored `scrollTop` synchronously.

**Root cause: browser scroll anchoring.** The list above the viewport anchor grows, so the browser
compensates a frame later and overrides the app's restore. Proved by isolation:

| CSS scope | delta |
| --- | --- |
| *(control — none)* | **+27px** |
| `[data-votes] { overflow-anchor: none }` | **+27px** — does not help (the anchor just moves below the list) |
| `html { overflow-anchor: none }` | **0px** ✅ |

So while you are reading or voting, a teammate opening a question **shifts your viewport**, and
POKER-011's guarantee silently did not hold for concurrent broadcasts.

## 2. Decision

1. **Fix it in CSS:** `overflow-anchor: none` on `html`. This app owns its scroll stability — POKER-011
   captures `scrollTop` and restores it in the same task as every rebuild — and it is a single column
   with nothing lazily loaded above the viewport, so anchoring buys nothing while actively fighting
   the app. Scoping it to `[data-votes]` is measurably insufficient (table above).
2. **Keep POKER-011's test honest:** its assertions are unchanged in meaning, but the interaction now
   retries across a rebuild instead of tripping over a detached node (lazy locators re-resolve).
3. **Add a deterministic regression test** that FORCES the concurrent rebuild and asserts the real
   promise — unchanged scroll offset and focus kept — instead of leaving the race to timing.

## 3. Acceptance criteria

- [x] AC1 — `html { overflow-anchor: none }` in `public/style.css`, with the reason in a comment.
- [x] AC2 — The deterministic test (second member opens a vote mid-interaction) passes; it **failed
      before the fix** with a ~27px delta, so it is a true regression guard. Red/green was proved by
      temporarily commenting the CSS rule out (**red: 27px**) and restoring it (**green**).
- [x] AC3 — POKER-011's scrolled-voting test keeps its meaning (offset must not move, focus stays on
      the same vote's select) and no longer fails on a detached node.
- [x] AC4 — Full suite green across **10 consecutive** runs (33 passed each, 0 failures); the baseline
      was 3 failures in 18 runs on a single test.
- [x] AC5 — `npm test` green; ticket committed, pushed, moved to `tickets/done/`.

## 4. Verification

- Root cause isolated by CSS scope (3 scenarios in one browser run): control **+27px**,
  `[data-votes] { overflow-anchor: none }` **+27px**, `html { overflow-anchor: none }` **0px**.
- Scroll sampled every animation frame over 1.2s: the shift is **persistent**, and lands ~114ms
  after the broadcast — after `renderVotes()`' synchronous restore.
- `npm test` → **117/117**.
- `npm run test:e2e` → **33 passed, 3 skipped** (live-gated) × **10 consecutive runs**, 0 failures.

## 5. Files

`public/style.css`, `e2e/scroll-stability.spec.ts`, this ticket.
