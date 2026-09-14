# POKER-015 — the connection line is hidden outside a room

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"this is tricky as it is not closed but it is saying closed on the opening page..
well maybe shall not say anything .. make tests for the before"*
**Status:** **DONE** (2026-09-13) — landed on `main` (`05d7a68`), pushed.

## 0. The two false states (verified in a browser, not by reading alone)

| screen | `data-connection` | line | socket? |
| --- | --- | --- | --- |
| fresh `/` (home) | `closed` | "connection: closed", **red** | none — `connect()` early-returns without a room |
| in a room | `open` | "connection: open", green | yes |
| home **after leaving** a room | `open` | "connection: open", green | none — closed by `closeSocket()` |

1. **False red on home.** `public/app.js` boot unconditionally calls `setConnection("closed")`
   and `public/index.html` hardcodes `data-connection="closed"`. Home has no room, so `connect()`
   returns immediately (`if (!state.roomCode) return;`) and nothing ever corrects the value. The
   header shows a failure that did not happen.
2. **False green after leaving.** `applyRoute()`'s home branch calls `closeSocket()` but never
   `setConnection(...)`. `closeSocket()` nulls `socket` *before* closing it, so the socket's own
   `close` handler hits `if (socket !== ws) return;` and its `setConnection("closed")` never runs.
   The header keeps showing green "open" with no socket at all.

**Why this survived:** `e2e/client-shell.spec.ts` asserted `data-connection="closed"` on `/` — the
suite locked in the "before" behavior, which is exactly why it looked deliberate.

## 1. Decision

The line reports the **room socket**. On home there is no room and no socket, so every value it
could show is a lie. Therefore: **hide `p.connection` entirely outside a room**, and keep the
in-room vocabulary (`connecting` / `open` / `closed`) exactly as it is.

- One rule kills both bugs instead of patching two code paths.
- The `data-connection` **attribute value** is unchanged, so `e2e/helpers.ts`' `expectConnection`
  union and every other spec stay valid — no contract churn.
- It matches the codebase's existing route-scoped chrome (`youLine`, `openVoteForm` are hidden by
  `inRoom` in `renderChrome`).
- **No** `idle`/`offline` value is invented: that is a new state to define, style and test for a
  screen that needs no indicator.

## 2. Acceptance criteria

- [x] AC1 — On a fresh `/`, the connection line is **hidden**; the `data-connection` attribute is
      still `closed` (the hook survives, the lie does not). The served HTML ships the line
      `hidden`, so a slow `app.js` cannot flash a red "closed" on first paint.
- [x] AC2 — In a room the line is visible and still reads `connecting` → `open`.
- [x] AC3 — Leaving a room for home hides the line again — the stale green `open` cannot be seen
      (the second false state, `closeSocket()` without `setConnection`), and the state is reset to
      `closed` so nothing downstream reads a stale `open`.
- [x] AC4 — **In-room behaviour is untouched:** a dropped socket still shows a *visible* `closed`
      and reconnects to a visible `open` (regression guard on the real signal).
- [x] AC5 — `e2e/client-shell.spec.ts` asserts the new contract (hidden on home) instead of the old
      `closed`-is-shown behaviour.
- [x] AC6 — `npm test` and `npm run test:e2e` green; ticket committed, pushed, moved to
      `tickets/done/`.

## 3. Files

`public/index.html` (`data-connection-line` hook), `public/app.js` (`renderRoute` hides it;
`els.connectionLine`), `e2e/connection-indicator.spec.ts` (new), `e2e/client-shell.spec.ts`,
this ticket.

## 4. Verification

- **Before (red):** the new spec was run against the unfixed tree — all 4 cases failed
  (AC1/AC3 on the false states, AC2/AC4 on the missing `data-connection-line` hook).
- **After (green):** `e2e/connection-indicator.spec.ts` + `e2e/client-shell.spec.ts` → 6 passed.
- `npm test` → **117/117**. `npm run test:e2e` → **32 passed, 3 skipped** (live-gated), three
  consecutive runs.
- **Known flake, not ours:** `e2e/scroll-stability.spec.ts:34` (POKER-011) failed once with
  *"Element is not attached to the DOM"* on `card.scrollIntoViewIfNeeded()` — a vote-list rebuild
  race. It **reproduced on the clean, pre-change tree** (1 of 3 full runs), so it is pre-existing
  and unrelated to this ticket. Worth its own ticket.
- Edits were made on the **z640**, not the deployed **g2**, so the live site is unaffected until
  this is pushed and deployed.
