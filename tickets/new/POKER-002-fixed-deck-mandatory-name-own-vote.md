# POKER-002 — fixed planning-poker deck, mandatory permanent name, and a visible own vote

**Project:** poker (this repo, `git@github.com:311ecode/poker.git`, branch `main`)
**Status:** **IN PROGRESS** (2026-09-13) — implementing directly on `main` (single cohesive slice).
**Created:** 2026-09-13
**Reporter:** user — voice memo, translated:

> *"It should work in the second round… if the user is not identified by name, they cannot do stuff —
> so first it's a must. And he cannot change [the name]. And when in a room, we shouldn't have more
> control — it's just a room and a go back. And it's quite hard to see what my vote is. It should run
> a vote from one to five… zero, 0.5, [1, 2, 3, 5, 8, 13]."*

## 0. Decisions confirmed with the user (do not re-litigate)

| # | Decision |
|---|---|
| 1 | **Fixed deck**, exactly **`0, 0.5, 1, 2, 3, 5, 8, 13`** — the classic planning-poker Fibonacci set. No free-text options. |
| 2 | **Round 2 = the same world.** Reopening a closed vote does **not** reset ballots; people simply **change their own choice**. History is irrelevant here. R6 stays as landed. |
| 3 | **Name is mandatory** before any vote action (open/cast/change/close/reopen) and **immutable** once claimed. Joining stays open; claiming is step one. |
| 4 | Room screen stays lean: **keep Members and History**, remove the extra forms (free-text options, always-on passcode retry, claim-after-claimed). |
| 5 | **My own vote must be obvious**, and changeable in round 2. |

## 1. Contract delta vs POKER-001 (amendment; the parent §1 was frozen, so the delta lives here)

- **§1.3 `vote_open`** becomes `{"t":"vote_open","title":"…"}`. `options` is **server-owned**: every
  new vote's options are exactly `VOTE_DECK`. An incoming `options` field is **ignored** (old clients
  keep working; a malicious client cannot open a custom deck).
- **New error codes** (§1.4): `name_required` (acting session has no claimed name) and `name_locked`
  (attempt to change a name already claimed). Both need a `public/messages.js` sentence.
- **Anonymity R1–R7 are untouched.** In particular **no per-person choice is added to the wire**:
  the viewer's own ballot is remembered **client-side only** (localStorage, per room). The
  `vote_you` frame keeps only `order` + `self`; `serializeVote` keeps its exact open-vote key set, so
  `public/leakguard.js` needs no relaxation.
- **Client storage** (§1.7 extension): `poker.selfchoices.<CODE>` = `{ "<voteId>": "<choice>" }`, a
  convenience only; the server ballot stays authoritative.

## 2. Acceptance criteria

- [ ] AC1 — `lib/votes.ts` exports `VOTE_DECK = ["0","0.5","1","2","3","5","8","13"]`; every vote
  opened through the protocol has exactly those options; a client-supplied `options` is ignored.
- [ ] AC2 — While a vote is open, an **unnamed** session is refused with `name_required` for
  `vote_open`, `vote_cast`, `vote_change`, `vote_close` and `vote_reopen` (check inside the same
  `db.mutate`, so it is race-safe). A session that has not joined keeps getting `not_in_room`.
- [ ] AC3 — A member that already has a name **cannot change it**: `claim` with a different name is
  `name_locked`; re-claiming the **same** name stays `claim_ok` (idempotent, so reconnect/reload
  works). A collision is still `name_taken` (R7).
- [ ] AC4 — The client shows a prominent **"Your vote: X"** line and marks the matching card
  (`data-self-choice="true"`, `aria-pressed="true"`); clicking another card changes the ballot
  (`vote_change`). The choice survives a vote **reopen** and a **page reload** (localStorage).
- [ ] AC5 — Client gating mirrors the server: until a name is claimed the open-vote form is hidden
  and the cards are disabled with a "claim a name first" hint; once claimed the claim form is gone
  and the name is shown read-only.
- [ ] AC6 — The room screen keeps Members, Votes (deck) and History, and removes the extra forms:
  no free-text options textarea; the passcode retry form appears only for a room that has a passcode
  (or after `bad_passcode`).
- [ ] AC7 — `npm test` green and `npm run test:e2e` green (serialised), including a new spec that
  proves name-gating, name immutability, the fixed deck and the visible/changed own vote.
- [ ] AC8 — Landed, pushed, live on **https://poker.imre.dev**, and this ticket moved to
  `tickets/done/`.

## 3. Files touched

`lib/votes.ts` (deck + gates), `lib/rooms.ts` (open without options), `server.ts` (drop `options`
forwarding), `public/{index.html,app.js,store.js,messages.js,style.css}`, `test/{protocol,http,store,messages}.test.ts`,
`e2e/helpers.ts` + affected specs, and this ticket.
