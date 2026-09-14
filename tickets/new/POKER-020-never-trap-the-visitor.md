# POKER-020 — never trap the visitor: identity refusals self-heal, and no silent dead ends

**Project:** poker (main) · **Created:** 2026-09-14
**Reporter:** user — *"when it's a new user and it's entering a room where we have a passcode, it kind
of cannot do that thing because it seems like an internal situation of a race condition."*
**Status:** **DONE** (see §5).
**Follows:** POKER-018 (the connection dance) and POKER-019 (the name gate) — this is the pair's
failure mode.

## 1. Reproduced

Nine passcode entry paths — link with/without a passcode, typed code, wrong then right passcode,
double-click, Enter-Enter, create-with-passcode — all pass on the local server **and** on the live
origin. The trap is not in the passcode path itself. It is in what happens when the server says
*"you already have an identity here"*, and it reproduces deterministically with **two tabs of the
same browser** (one shared session, so a name is locked per session):

```
both at the name gate:   A: state=name error=         you=""   gate=true
                         B: state=name error=         you=""   gate=true
after both claimed:      A: state=name error=name_locked  you=""  gate=true   *** STUCK ***
                         B: state=live error=             you="TabB" gate=false  OK
```

Tab A can never get in again. Every retry answers `name_locked`, the client treats that as a user
error and holds the gate open, and the tab's own `state.you.name` stays empty — even though its
session IS the named member `TabB`. Only a manual reload escapes.

**The same trap needs no second tab.** A `claim_ok` lost in flight (the POKER-018 dance did exactly
this, twice a minute) leaves the server with your name and the client believing you have none:
`nameIsThePath()` stays true, and the next claim attempt is `name_locked` — stuck.

## 2. Two more dead ends found while reproducing

- `roomState()` mapped **every** non-passcode admission refusal (`bad_session`, `rate_limited`,
  `server_error`, `room_full`) to `connecting`: no passcode field, no retry button, nothing. A
  visitor whose session id was refused sat on a silent "connecting" screen forever.
- A `hello` that got **no answer at all** (dropped handshake, half-open socket) also sat on
  `connecting` forever: the socket stayed open, so nothing ever reconnected.

## 3. Fix

1. **`name_locked` re-syncs instead of asking again.** The code means "the server already holds a
   name for this session", so the client re-sends `hello`, learns `you.name` from `hello_ok`, and
   goes live. One attempt per room, so a persistent refusal cannot loop.
2. **`bad_session` mints a fresh session.** `resetSession()` (new, in `store.js`) drops the refused
   id and generates a new one, then reconnects. A junk id is not a dead end.
3. **A refusal that is not the passcode gets a retry card.** New `data-room-state="retry"` with
   `[data-retry]` — the refusal is explained in place (the single `[data-error]` node moves in, as at
   the other gates) and `[data-action="retry-connect"]` is focused and ready.
4. **A `hello` that gets no answer reconnects.** `HELLO_TIMEOUT_MS = 10s`: armed on socket open,
   cleared by any inbound frame or close; if nothing at all arrives, the socket is closed so the
   ordinary close handler recovers.

## 4. Acceptance criteria

- [x] AC1 — the two-tab race ends with **both** tabs live on the one winning name; neither is trapped
      (`e2e/entry.spec.ts`, falsified: without the re-sync the loser stays at `name`).
- [x] AC2 — a non-passcode refusal shows `retry` + a focused way forward, and trying again is
      admitted (proven with a WebSocket route that refuses the first `hello` only).
- [x] AC3 — `bad_session` rotates the session id (`test/store.test.ts`, including the TypeError guard).
- [x] AC4 — a `hello` with no answer closes the socket within 10s instead of hanging on `connecting`.
- [x] AC5 — the passcode/name entry paths are unchanged: all nine live flows still pass.
- [x] AC6 — `npm test` **123/123**; `npm run test:e2e` **41 passed / 3 skipped / 0 failed**.

## 5. Verification

| Check | Result |
|---|---|
| Falsification (heal disabled) | two-tab test **fails**: loser `data-room-state="name"` after 10s |
| With the heal | two-tab test **passes** in 533ms, both tabs `live`, same name |
| Full suite | unit **123/123** · e2e **41 passed / 3 skipped / 0 failed** |
| Live origin | see the landing note below |

## 6. Files

`public/app.js` · `public/store.js` · `public/index.html` · `e2e/entry.spec.ts` ·
`test/store.test.ts` · this ticket.

## 7. Also cleaned up

The live race hunt created a room through the UI (`Own protected room`, code `P7JNHR`) that its
cleanup did not know about. It was **deleted from the deployed origin**; the probe has been fixed to
sweep UI-created rooms too, so production holds only real rooms.
