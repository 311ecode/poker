# POKER-001b — poker: the room-file database (one JSON file per room, atomic + serialized)

**Reporter:** user — *"database is multiple json file per room one json."*
**Parent:** [POKER-001](POKER-001-poker-imre-dev-realtime-voting-app.md) — the schema in §1.1 is the
contract; this ticket implements it.
**Repo:** `311ecode/poker` (worktree `~/dev/poker-b-work`, own branch).
**Depends on:** the §1.1 schema only — **starts immediately, in parallel with 182a.**
**Blocks:** nothing hard; 182a consumes this interface.

## Summary

The whole database is `data/rooms/<CODE>.json`. This ticket makes that safe: an atomic writer, a
per-room write lock so two concurrent requests can't interleave, a typed load/validate path that
fails loud on corruption, and the query helpers the fleet needs (public room list, room history).
No index file, no event log, no DB engine.

## Requirements / Acceptance criteria

- [ ] **AC1** `lib/db.ts` exports `openDb({ dir })` → `{ get(code), list(), create(room),
      mutate(code, fn), remove(code) }`; `mutate` is the **only** write path.
- [ ] **AC2** **One mutation writes exactly one file** — the room's own. A test mutates room A and
      asserts rooms B and C keep their previous `mtime` **and** byte-identical content.
- [ ] **AC3** **Atomic:** the write goes to `data/rooms/.<CODE>.tmp` then `rename()`s over the
      target. A test kills the writer between temp-write and rename and asserts the previous file
      is still intact and parseable (no half-written room).
- [ ] **AC4** **Serialized per room, parallel across rooms:** `mutate` chains on a per-code promise
      lock. A test fires 50 concurrent `mutate("A", …)` and sees 50 sequential applied results;
      concurrently fires `mutate("A")` and `mutate("B")` and asserts they overlap (B is not blocked
      by A).
- [ ] **AC5** **Fail loud on corruption:** an unparseable/invalid room file makes `get` throw a
      typed `RoomCorruptError` (never an empty room); `list()` skips corrupt files **and reports
      them** (count + names) rather than hiding them.
- [ ] **AC6** Schema validation on load **and** on mutate: `code` matches `/^[A-Z0-9]{6}$/`,
      `votes[].state ∈ {open,closed}`, `ballots[].session` unique per vote, `options` non-empty.
      A rejected mutation leaves the file untouched.
- [ ] **AC7** `passcodeHash` is stored, never a plaintext passcode; `list()` returns only
      `public !== false` rooms and projects `{code,title,members,hasPasscode}` — never the hash.
- [ ] **AC8** History projection: `history(code)` returns votes with `events` and, for **closed**
      votes only, `result` + `reveal` (names). For **open** votes it returns counts only — the
      R1/R2 invariant holds at the DB boundary too, so a leak can't be introduced by a caller.
- [ ] **AC9** Room codes avoid ambiguous glyphs (`0/O`, `1/I/L`); a test asserts the generator's
      alphabet and length.
- [ ] **AC10** `data/` is gitignored; a `DATA_DIR` env var overrides the path (needed by e2e and
      by the worktree isolation rule).

## Tests

```bash
npm test        # node --test — pure fs, no server needed
```

Each test uses its own `mkdtemp` `DATA_DIR`. The AC2/AC3/AC4 tests are the point of this ticket —
they are the reason it is a separate slice. Include a **10k-room** `list()` timing sanity check
(no index, so `list()` reads N files; assert it stays under a stated budget and document the
ceiling).

## Notes for the implementer

- Rename is only atomic within one filesystem — keep the temp file inside `data/rooms/`.
- Use `JSON.stringify(room, null, 2)` so the files stay human-readable and diffable (the user
  wants them visible).
- Do **not** add caching beyond the per-room lock; a stale in-memory cache reintroduces the
  lost-write bug this ticket exists to prevent.
- `lastSeenAt` presence updates are frequent; keep the write path cheap (no full re-validate of
  unrelated rooms) and document the write volume.

## Done checklist

- [ ] AC1–AC10 ticked · `npm test` green · worktree removed, merged, pushed
- [ ] Ticket moved to `tickets/done/` with `git mv`
