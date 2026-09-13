# POKER-001a — poker: server core (HTTP + WebSocket protocol, rooms, votes, name claims)

**Reporter:** user — *"realtime communication … create a room … a user logs in and new requested
for the name … anyone can start a new voting … anyone can close and reopen votes … no
authentication."*
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md) — **the contract in
§1 is frozen here; do not change a message shape without updating the parent.**
**Repo:** new `311ecode/poker` (create it; worktree `~/dev/poker-a-work`, own branch).
**Depends on:** nothing — this is the **spine**.
**Blocks:** 182c, 182d, 182e (they start the moment this lands a protocol stub).
**Machine:** develop here; the first deploy is 182d's job.

## Summary

Bootstrap the app repo and build the server: one Node HTTP server that also owns the WebSocket
upgrade, an in-memory room manager backed by `lib/db.ts` (182b), the vote state machine, realtime
name claims, and the `/api/*` surface. No framework, no bundler, no build step — Node ≥ 26.8.1
type-stripping (`node server.ts`), exactly like offtube.

## Requirements / Acceptance criteria

- [x] **AC1** The repo is live (`311ecode/poker`, pushed 2026-09-13 — no longer blocked). Add
      `package.json`
      (`type: module`, `engines.node >= 26.8.1`), `.gitignore` (`data/`, `.pm2/`, `.pw-browsers/`,
      `.cloudflared/`, `.env`), the **`SSPL-1.0`** license set — `LICENSE` (verbatim, **already
      landed** — do not edit), `COPYRIGHT`, `RESTRICTIONS.md` — and `"license": "SSPL-1.0"` in
      `package.json`.
- [x] **AC2** `node server.ts` serves `public/` and answers `GET /api/health` →
      `{ok:true,version,rooms,connections,uptime}`.
- [x] **AC3** A single `http.Server` handles the WS upgrade on the **same port** (no second port);
      `ping` → `pong`; unparseable/malformed frames get `{"t":"error","code":"bad_message"}` and do
      **not** kill the connection or the process.
- [x] **AC4** `hello` joins/creates the session in a room; a wrong/missing passcode on a protected
      room → `bad_passcode` and the socket is not admitted.
- [x] **AC5** `claim` enforces **uniqueness per room in realtime**: first claim wins, the second
      gets `name_taken`; a rename that collides is also rejected (R7).
- [x] **AC6** `vote_open` / `vote_cast` / `vote_change` / `vote_close` / `vote_reopen` implement the
      state machine: casts only while `open`; `vote_closed`/`vote_reopened` emit the new state;
      `events` gets `opened|closed|reopened` with `by` = session.
- [x] **AC7** **Anonymity:** a `vote_update` for an `open` vote contains counts + `votedCount` and
      **no** `name`, `reveal`, `ballots` or per-person choice. `reveal` appears only for closed
      votes. (R1/R2 — the parent's hard invariant.)
- [x] **AC8** `vote_you` sends each connection its own `order` (seeded by that session + vote id,
      **stable**, **self last**) — computed server-side, never persisted.
- [x] **AC9** `room_create` / `room_list` / `room_join`; `room_list` returns **public rooms only**
      and never a passcode; `hasPasscode` is a boolean.
- [x] **AC10** HTTP `GET /api/rooms`, `POST /api/rooms`, `GET /api/rooms/:code`,
      `GET /api/rooms/:code/history` per parent §1.5.
- [x] **AC11** Rate limits + caps enforced (message ≤ 64 KiB, ≤ 32 options, name ≤ 24 chars,
      ≤ 200 members/room, ≤ 50 votes/room); exceeding them is a clean `error`, not a crash.
- [x] **AC12** All persistence goes through `lib/db.ts`'s public API only — **182a never touches
      `fs` for room state**. One mutation = one `room.mutate()` call.
- [x] **AC13** `instances: 1` documented as mandatory (in-memory state) in the README.

## Tests

```bash
npm test          # node --test; each test boots the server on port 0 with a temp DATA_DIR
```

- WS unit tests: claim collision, passcode reject, open→cast→close→reopen transitions, and the
  **wire assertion** that an open `vote_update` has no `name`/`reveal`/`ballots` key.
- Ordering tests: same viewer twice → identical `order`; different viewers → different `order`;
  `order`[-1] === `self` always.
- Malformed frame / oversize message / bad JSON → error, socket alive, process alive.

## Notes for the implementer

- Read `~/dev/offtube/server.ts` first; mirror its structure, naming and no-build style. Parent
  §1.9 lists **every** reference asset with its size (pm2-start, both systemd units,
  `setup-cloudflare.mjs`, `lib/cloudflare.ts`, `playwright.config.ts`) — copy, don't invent.
- **Transport: hand-rolled WebSocket over `http`'s `upgrade` event, zero runtime dependencies**
  (parent §1.8). Text frames, ping/pong, close, 7/16/64-bit lengths, and **unmasking of masked
  client frames** are required. Do not add `ws` without escalating.
- Session id format and the client `localStorage` keys are frozen in parent §1.7 — accept them as
  given in `hello`; do not invent a second scheme.
- `Net`-level details: `server.on("upgrade", …)`, reject upgrades for unknown paths with 404, and
  keep a per-connection map `session → socket` for presence broadcasts.
- The `lib/db.ts` interface (owned by 182b) is frozen in the parent §1.1; code against it, and if
  182b has not landed yet, a 10-line in-memory stub behind the same interface is acceptable **only
  in tests** — never a second implementation in `server.ts`.
- Presence: `lastSeenAt` updates are a mutation like any other (they go through `room.mutate()`).

## Done checklist

- [x] AC1–AC13 ticked · `npm test` green · worktree removed, merged, pushed
- [x] Ticket moved to `tickets/done/` with `git mv`

---

## Verification & landing (coordinator, 2026-09-13)

**Landed on `main`:** merge of `poker/a-server-core` (`37418ac`, merge commit `d4121e4`), pushed. `npm test` in the main checkout: **77 tests / 12 suites / 0 fail** (46 from `001b` + 31 from this slice). The module under test is the real `lib/db.ts` — `server.ts` statically imports `./lib/db.ts`, and no stub exists in server source (the test-only stub path was never needed because `001b` landed first).

**Falsification (parent §4.1.1) — recorded:** removing the `if (vote.state === "closed")` guard in `serializeVote` so open votes also emitted `result`/`reveal` made the wire test fail with
`AssertionError: vote_update (open) leaked key "name" on the wire: {"t":"vote_update","vote":{…,"state":"open",…,"reveal":[{"name":"Bob","choice":"Bob"}]}}`.
Reverted; suite green again. The anonymity rule is therefore enforced by a test that can fail.

**Reviewer's independent run:** the suite was copied to a scratch tree and run by the coordinator (not the author) — 31/31 pass, including the raw-frame anonymity assertion, the N-way simultaneous `claim` race (exactly one winner), `order[-1] === self` with per-viewer-different and stable ordering, RFC 6455 framing (7/16/64-bit, masked/unmasked, fragmented, ping/pong, close), caps, rate limiting, and the HTTP surface. Code review confirmed `revealFor()` has exactly one caller (`serializeVote`, gated on `state === "closed"`) and that `orderFor()` is a pure seeded Fisher–Yates over **all** members with self spliced last — it is never persisted.

**Interface handed to `001c`/`001e`/`001d`:** WS path `/ws` (other upgrades 404; missing key/version 400); `hello` and `room_join` are aliases, reply `hello_ok` → `presence` → one `vote_you` per open vote; `claim` → `claim_ok` (names collide case-insensitively); open-vote pushes are `vote_new`/`vote_update` (counts + `votedCount` only) and `vote_closed` (adds `result` + `reveal`) / `vote_reopened` (names hidden again). Error codes: `bad_message, bad_room, bad_session, bad_passcode, not_in_room, name_taken, name_too_long, bad_name, bad_title, bad_options, too_many_options, too_many_votes, room_full, bad_vote, bad_choice, vote_closed, vote_open, rate_limited, server_error`. `PORT` unset → ephemeral port 0 (test-friendly), `PORT=fixed` → 64100; SIGINT/SIGTERM close gracefully.

**Known and accepted at this point:** `GET /` 404s until `001c` lands `public/**` (static serving itself is tested against a temp dir); a `history` *client* message is a documented extension on top of the frozen §1.3 set (HTTP `GET /api/rooms/:code/history` remains the contract path); framing violations answer `bad_message` then close that socket with 1002 because stream position is unrecoverable, while bad JSON/oversize keep the socket alive.
