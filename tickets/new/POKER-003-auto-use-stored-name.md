# POKER-003 — the claimed name is burned into the browser and used automatically

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — *"if name claimed you do not reclaim it, use it — it will be burned into your
browser localStorage for life."*

## 0. Decision

Once a visitor has claimed a name, that name lives in the browser's `localStorage`
(`poker.name`, the existing POKER-001 §1.7 key) **for life** and is **used, not re-asked**:

1. Entering a room whose server state **already knows this session** → the name from `hello_ok` is
   used; the client sends **no `claim` frame at all**.
2. Entering any **other** room with a stored name → the client **silently claims** it once, so the
   visitor is named without touching the form. (Names are unique *per room* — POKER-001 R7 — so the
   first claim in a room is unavoidable; what we stop is re-claiming what is already ours.)
3. No stored name yet → the claim form is the path (unchanged).
4. If the stored name is **rejected in that room** (taken), the form appears with the error so
   another name can be chosen.

**Contract impact: none on the wire or the server.** This is client-only; the existing `claim`
message and `name_locked`/`name_taken` codes already cover it. `serializeVote` and R1–R7 are
untouched.

## 1. Acceptance criteria

- [ ] AC1 — After a successful claim, `localStorage["poker.name"]` holds the name, and every later
  room entry in that browser is named without any typing.
- [ ] AC2 — In a room the server already knows this session in, the client sends **zero** `claim`
  frames (asserted on the wire via Playwright `framesent`), including after a reload.
- [ ] AC3 — In a room it does not know yet, the client sends **exactly one** silent `claim` with the
  stored name, and the claim form is never shown.
- [ ] AC4 — With no stored name, the claim form is shown (unchanged), and a rejected stored name
  (`name_taken`) reveals the form so a different name can be chosen.
- [ ] AC5 — `npm test` and `npm run test:e2e` green (serialised); live smoke green on
  `poker.imre.dev`; ticket moved to `tickets/done/`.

## 2. Files

`public/app.js` (auto-claim + form gating), `e2e/helpers.ts` (`recordSentFrames`),
`e2e/name-claim.spec.ts` (the new proof), plus this ticket.
