# POKER-001e — poker: Matrix-style ASCII banner font + screens + theme

**Reporter:** user — *"we want matrix style big letters … we do show how voted … names are not
visible … the order of the voters are random, each person is the last one."*
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md) — §1.2 rules, §1.4 frames.
**Repo:** `311ecode/poker` (worktree `~/dev/poker-e-work`, own branch).
**Depends on:** 182a's protocol stub. **Parallel with:** 182b, 182c, 182d.
**Owns:** `lib/asciiFont.ts` and **`public/style.css` end to end** (parent §1.6 CSS rule — 001c
leaves `/* POKER-001e: style this */` markers and creates no stylesheet).

## Summary

The look and the interaction states: big block-letter banners for the room name, vote title and the
reveal, the anonymous "who voted" strip with per-viewer ordering, the live tally, the closed/reveal
state, history, and the rooms screens. The banner is **generated from a glyph table**, never
hand-drawn, and is proven equal-width by a unit test.

## Requirements / Acceptance criteria

- [ ] **AC1** `lib/asciiFont.ts`: a **5-row glyph table** for `A–Z 0–9 space - . _`, and
      `renderBanner(text): string[]` returning **exactly 5 equal-visual-width rows**.
- [ ] **AC2** Width is computed by **visual width**, not `String.length`: box-drawing and block
      characters (`U+2500–U+259F`, which are East-Asian *ambiguous*) occupy **one** cell. A naive
      `.slice()`/`.length` corrupts the banner — this was observed while designing the parent and
      must be pinned by a test.
- [ ] **AC3** Unit test: for an enumerated list (`POKER`, `NEW VOTE`, `REVEAL`, `MY ROOMS`,
      `VOTE HISTORY`, `CLOSED`, `WAITING`, `NO VOTES YET`, `ABSTAIN`, `YES`, `NO`, `3 2 1`) assert
      **all five rows have equal visual width** and **no glyph cell was clipped**. The test must
      **fail** if the font's cell width is reduced by one — falsify it before claiming it.
- [ ] **AC4** Every screen has a defined banner + empty/loading/error state:
      landing/name-claim, rooms (find + my rooms), room with no vote, room with an open vote, room
      with a closed vote (reveal), history.
- [ ] **AC5** **Open-vote voter list (R2/R3/R4):** renders one row per ballot with **no name**, the
      order coming from the server's `vote_you.order`, **stable across re-render**, **self last**
      and marked as you.
- [ ] **AC6** **Live tally:** counts update without a reload; "N of M voted" progress; no
      per-person attribution while open.
- [ ] **AC7** **Reveal:** on `vote_closed`, show the big-letter reveal moment, the per-option bars
      and the named list; on `vote_reopened`, return to the anonymous state (R5/R6).
- [ ] **AC8** **History** screen lists votes with final result for closed ones and the
      open/close/reopen events; open votes show counts only.
- [ ] **AC9** **Mobile fallback:** below ~480 px the 20-column banner cannot fit, so a
      single-row letterspaced text treatment replaces it; documented breakpoint, no horizontal
      overflow (`scrollWidth === clientWidth`).
- [ ] **AC10** Contrast in both light and dark themes is at least 4.5:1 for text (this fleet has
      been burned by an unreadable light-mode colour — DASH-138); measure it, don't eyeball it.
- [ ] **AC11** The banner is `<pre>` with `white-space: pre` + `line-height: 1` + a monospace
      stack, and the spacing survives a font that lacks some box-drawing glyph (fallback check).
- [ ] **AC12** All test hooks are `data-*` attributes (shared convention with 182c) — no test
      scrapes prose.

## Tests

```bash
npm test        # includes test/asciiFont.test.ts — the equal-width + no-clip proof
npm run test:e2e   # a presentation spec: reveal state, ordering stability, mobile fallback
```

- `test/asciiFont.test.ts`: equal width for the enumerated list; **falsification** case (shrink the
  cell by 1 → the test fails).
- `e2e/presentation.spec.ts`: order is stable across a refresh, self is last, mobile viewport has
  no overflow, reveal appears on close.

## Notes for the implementer

- Keep the font table and the renderer in **one** module; the client imports it directly (ES
  module, no build step).
- Render the banner from the **room/vote text**, so a room called `FRIDAY NIGHT` gets a real
  banner — not a fixed image.
- Reveal moment: a brief animation is welcome, but it must be **skippable** and must not delay the
  data (assert the reveal text is present immediately, animate only its presentation).

## Done checklist

- [ ] AC1–AC12 ticked · tests green (incl. the falsification run) · worktree removed, merged, pushed
- [ ] Ticket moved to `tickets/done/` with `git mv`
