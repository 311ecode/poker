# POKER-013 — test data is marked and cleaned up; `/resetdata` wipes data

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"We got some tests which are creating new data. At least those data should be
somehow removed… https://poker.imre.dev/resetdata should be implemented [as a] full data reset as
well. But don't use it from your test on the semi-live system of the imre.dev."*
**Status:** IN PROGRESS

## 0. Decisions

1. **Test rooms are marked.** `POST /api/rooms` accepts `test: true`, stored on the room file
   (`Room.test`). The gated live smoke creates its rooms that way.
2. **Tests clean up after themselves.** `DELETE /api/rooms/:code` removes one room. The live smoke
   deletes every room it created in a `finally` — it must **never** call `/resetdata` on the live
   origin.
3. **`GET /resetdata` is a confirmation page, not an action.** It shows how many rooms exist and how
   many are test rooms, with two POST buttons (test-only / everything). A GET has no side effects, so
   a crawler, prefetch or link preview cannot wipe the server.
4. **`POST /resetdata`** requires `confirm=RESET` and a `scope`:
   - `scope=test` — rooms flagged `test`, or legacy test rooms whose title starts with `live-`
     (that is how the accumulated live-smoke rooms are identified);
   - `scope=all` — every room file.
5. **Optional admin token.** If `POKER_ADMIN_TOKEN` is set in the environment, every destructive
   request must carry it (`X-Poker-Token` header, or a `token` field on the reset form); otherwise
   the confirm field alone is enough. Destructive endpoints are unauthenticated by default, matching
   the app's no-auth stance — the token is the lever to lock them down.

## 1. Acceptance criteria

- [ ] AC1 — `DELETE /api/rooms/:code` (header `X-Poker-Confirm: delete`) removes that room and its
  file; an unknown code is `404`; without the confirm header it is `403`.
- [ ] AC2 — `GET /resetdata` has **no** side effects and reports the total and test-room counts.
- [ ] AC3 — `POST /resetdata` without `confirm=RESET` is refused; `scope=all` removes every room;
  `scope=test` removes only flagged/legacy-test rooms and leaves real rooms alone.
- [ ] AC4 — A room created with `test: true` round-trips the flag; the live smoke marks its rooms
  and deletes them in `finally` without touching `/resetdata`.
- [ ] AC5 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to
  `tickets/done/`.

## 2. Files

`lib/db.ts` (`test` flag, `listCodes`), `lib/rooms.ts` (`deleteRoom`, `resetData`, peer drop),
`server.ts` (DELETE + `/resetdata` + admin token), `e2e/helpers.ts`, `e2e/live-smoke.spec.ts`,
`test/http.test.ts`, `README.md`, this ticket.
