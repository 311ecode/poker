// test/store.test.ts — unit tests for the client-side pure helpers
// (POKER-001c AC5). The My Rooms store is the important one: it is the ONLY
// place the browser persists room history, and the server must never see it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureSession,
  forgetPasscode,
  forgetRoom,
  forgetSelfChoices,
  memoryStorage,
  MY_ROOMS_LIMIT,
  normalizeCode,
  readLastRoom,
  readMyRooms,
  readName,
  readPasscode,
  readSelfChoices,
  readSession,
  rememberRoom,
  resetSession,
  ROOM_PASSCODE_PREFIX,
  SELF_CHOICES_PREFIX,
  STORAGE_KEYS,
  writeLastRoom,
  writeMyRooms,
  writeName,
  writePasscode,
  writeSelfChoices,
} from "../public/store.js";

const uuid = (n: number) => `0000000${n}-1111-4111-8111-11111111111${n}`;

test("normalizeCode accepts 6 uppercase alphanumerics and rejects the rest", () => {
  assert.equal(normalizeCode("f4k2qh"), "F4K2QH");
  assert.equal(normalizeCode(" F4K2QH "), "F4K2QH");
  assert.equal(normalizeCode("ABC"), null);
  assert.equal(normalizeCode("F4K2Q!"), null);
  assert.equal(normalizeCode(""), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(42), null);
});

test("memoryStorage behaves like localStorage for the keys we use", () => {
  const storage = memoryStorage();
  assert.equal(storage.getItem(STORAGE_KEYS.myRooms), null);
  storage.setItem(STORAGE_KEYS.myRooms, "[]");
  assert.equal(storage.getItem(STORAGE_KEYS.myRooms), "[]");
  assert.equal(storage.length, 1);
  storage.removeItem(STORAGE_KEYS.myRooms);
  assert.equal(storage.getItem(STORAGE_KEYS.myRooms), null);
});

test("ensureSession generates s-<uuid> once and reuses the stored id", () => {
  const storage = memoryStorage();
  const cryptoObj = { randomUUID: () => uuid(1) };
  const first = ensureSession(storage, cryptoObj);
  assert.equal(first, `s-${uuid(1)}`);
  assert.match(first, /^s-[0-9a-f-]{36}$/);
  assert.equal(storage.getItem(STORAGE_KEYS.session), first);

  // A second call must not regenerate — the identity is per browser (§1.7).
  const second = ensureSession(storage, { randomUUID: () => uuid(2) });
  assert.equal(second, first);
});

test("POKER-020: resetSession mints a genuinely new id instead of reusing the refused one", () => {
  const storage = memoryStorage();
  const first = ensureSession(storage, { randomUUID: () => uuid(7) });
  assert.equal(readSession(storage), first);

  const second = resetSession(storage, { randomUUID: () => uuid(8) });
  assert.equal(second, `s-${uuid(8)}`);
  assert.notEqual(second, first, "a refused session id is never sent again");
  assert.equal(readSession(storage), second, "the new id is persisted");

  // …and it is idempotent in the sense that a *stored valid* id is still
  // replaced on demand (that is the whole point: the server said no to it).
  assert.equal(resetSession(storage, { randomUUID: () => uuid(9) }), `s-${uuid(9)}`);
  assert.throws(() => resetSession(undefined, { randomUUID: () => uuid(1) }), TypeError);
});

test("ensureSession replaces a corrupt/blank stored session", () => {
  const storage = memoryStorage({ [STORAGE_KEYS.session]: "not-a-session" });
  const session = ensureSession(storage, { randomUUID: () => uuid(3) });
  assert.equal(session, `s-${uuid(3)}`);
  assert.equal(readSession(storage), session);

  const blank = memoryStorage({ [STORAGE_KEYS.session]: "   " });
  assert.equal(ensureSession(blank, { randomUUID: () => uuid(4) }), `s-${uuid(4)}`);
});

test("name is a prefill convenience: trimmed, cleared when empty", () => {
  const storage = memoryStorage();
  assert.equal(readName(storage), "");
  assert.equal(writeName(storage, "  Alice  "), "Alice");
  assert.equal(readName(storage), "Alice");
  assert.equal(writeName(storage, "   "), "");
  assert.equal(storage.getItem(STORAGE_KEYS.name), null);
});

test("lastRoom round-trips a normalized code", () => {
  const storage = memoryStorage();
  assert.equal(readLastRoom(storage), null);
  assert.equal(writeLastRoom(storage, "f4k2qh"), "F4K2QH");
  assert.equal(readLastRoom(storage), "F4K2QH");
  writeLastRoom(storage, "nope");
  assert.equal(readLastRoom(storage), null);
});

test("My Rooms is most-recent-first, deduplicated, and stable on ties", () => {
  const storage = memoryStorage();
  assert.deepEqual(readMyRooms(storage), []);

  rememberRoom(storage, "AAAAAA", 1000);
  rememberRoom(storage, "BBBBBB", 2000);
  rememberRoom(storage, "CCCCCC", 3000);
  assert.deepEqual(
    readMyRooms(storage).map((entry) => entry.code),
    ["CCCCCC", "BBBBBB", "AAAAAA"],
  );

  // Re-visiting moves the room to the front with a fresh timestamp, no dupe.
  rememberRoom(storage, "AAAAAA", 4000);
  assert.deepEqual(
    readMyRooms(storage).map((entry) => entry.code),
    ["AAAAAA", "CCCCCC", "BBBBBB"],
  );
  assert.equal(readMyRooms(storage).length, 3);

  // Ties fall back to code order so the render is deterministic.
  const tied = memoryStorage();
  writeMyRooms(tied, [
    { code: "BBBBBB", lastVisitAt: 5 },
    { code: "AAAAAA", lastVisitAt: 5 },
  ]);
  assert.deepEqual(
    readMyRooms(tied).map((entry) => entry.code),
    ["AAAAAA", "BBBBBB"],
  );
});

test("readMyRooms sanitizes corrupt/foreign entries instead of throwing", () => {
  const storage = memoryStorage({ [STORAGE_KEYS.myRooms]: "{not json" });
  assert.deepEqual(readMyRooms(storage), []);

  storage.setItem(STORAGE_KEYS.myRooms, JSON.stringify({ code: "AAAAAA" }));
  assert.deepEqual(readMyRooms(storage), []);

  storage.setItem(
    STORAGE_KEYS.myRooms,
    JSON.stringify([
      null,
      "AAAAAA",
      { code: "bad" },
      { code: "bbbbbb", lastVisitAt: "nope" },
      { code: "CCCCCC", lastVisitAt: 7 },
      { code: "CCCCCC", lastVisitAt: 99 }, // duplicate: first wins
    ]),
  );
  assert.deepEqual(readMyRooms(storage), [
    { code: "CCCCCC", lastVisitAt: 7 },
    { code: "BBBBBB", lastVisitAt: 0 },
  ]);
});

test("rememberRoom ignores a non-code and returns the unchanged list", () => {
  const storage = memoryStorage();
  rememberRoom(storage, "AAAAAA", 1);
  const after = rememberRoom(storage, "nope", 2);
  assert.deepEqual(after.map((entry) => entry.code), ["AAAAAA"]);
});

test("My Rooms is capped so localStorage cannot grow forever", () => {
  const storage = memoryStorage();
  for (let i = 0; i < MY_ROOMS_LIMIT + 10; i++) {
    const code = i.toString(36).toUpperCase().padStart(6, "0").slice(-6);
    rememberRoom(storage, code, 1000 + i);
  }
  const entries = readMyRooms(storage);
  assert.equal(entries.length, MY_ROOMS_LIMIT);
  // The newest survive.
  assert.equal(entries[0]!.lastVisitAt, 1000 + MY_ROOMS_LIMIT + 9);
});

test("forgetRoom removes one code and leaves the rest ordered", () => {
  const storage = memoryStorage();
  rememberRoom(storage, "AAAAAA", 1);
  rememberRoom(storage, "BBBBBB", 2);
  const left = forgetRoom(storage, "bbbbbb");
  assert.deepEqual(left.map((entry) => entry.code), ["AAAAAA"]);
});

test("every store helper rejects a non-Storage argument loudly", () => {
  assert.throws(() => readMyRooms(null), TypeError);
  assert.throws(() => rememberRoom({}, "AAAAAA"), TypeError);
  assert.throws(() => ensureSession(undefined, { randomUUID: () => uuid(1) }), TypeError);
});

// POKER-002: the viewer's OWN ballots, remembered per room. Client-only by
// contract — this is a convenience mirror, never sent anywhere.

test("self choices round-trip per room and never leak across rooms", () => {
  const storage = memoryStorage();
  writeSelfChoices(storage, "AAAAAA", [["v1", "3"], ["v2", "0.5"]]);
  writeSelfChoices(storage, "BBBBBB", [["v1", "13"]]);

  assert.deepEqual(readSelfChoices(storage, "AAAAAA"), [["v1", "3"], ["v2", "0.5"]]);
  assert.deepEqual(readSelfChoices(storage, "BBBBBB"), [["v1", "13"]]);
  assert.deepEqual(readSelfChoices(storage, "CCCCCC"), []);
  // Stored under the documented prefix, one key per room.
  assert.ok(storage.getItem(`${SELF_CHOICES_PREFIX}AAAAAA`));
});

test("self choices drop corrupt entries, honour the cap, and clear when empty", () => {
  const storage = memoryStorage();
  assert.deepEqual(readSelfChoices(storage, "AAAAAA"), []);
  // A non-array, an odd entry and a blank choice are all ignored.
  storage.setItem(`${SELF_CHOICES_PREFIX}AAAAAA`, JSON.stringify([["v1", "3"], "junk", ["v2", ""], ["", "5"]]));
  assert.deepEqual(readSelfChoices(storage, "AAAAAA"), [["v1", "3"]]);

  const many = Array.from({ length: MY_ROOMS_LIMIT + 5 }, (_, index) => [`v${index}`, "1"]);
  const written = writeSelfChoices(storage, "AAAAAA", many);
  assert.equal(written.length, MY_ROOMS_LIMIT);

  assert.deepEqual(writeSelfChoices(storage, "AAAAAA", []), []);
  assert.equal(storage.getItem(`${SELF_CHOICES_PREFIX}AAAAAA`), null);

  forgetSelfChoices(storage, "AAAAAA");
  assert.deepEqual(readSelfChoices(storage, "AAAAAA"), []);
});

// POKER-007: the room passcode this browser was admitted with, per room.

test("room passcodes round-trip per room and are never shared across rooms", () => {
  const storage = memoryStorage();
  assert.equal(readPasscode(storage, "AAAAAA"), "");
  writePasscode(storage, "AAAAAA", "s3cret");
  writePasscode(storage, "BBBBBB", "other");

  assert.equal(readPasscode(storage, "AAAAAA"), "s3cret");
  assert.equal(readPasscode(storage, "bbbbbb"), "other");
  assert.equal(readPasscode(storage, "CCCCCC"), "");
  assert.equal(storage.getItem(`${ROOM_PASSCODE_PREFIX}AAAAAA`), "s3cret");

  // An empty or over-long passcode clears rather than stores; forget removes.
  assert.equal(writePasscode(storage, "AAAAAA", ""), "");
  assert.equal(readPasscode(storage, "AAAAAA"), "");
  assert.equal(writePasscode(storage, "AAAAAA", "x".repeat(129)), "");
  assert.equal(readPasscode(storage, "AAAAAA"), "");
  writePasscode(storage, "AAAAAA", "again");
  forgetPasscode(storage, "AAAAAA");
  assert.equal(readPasscode(storage, "AAAAAA"), "");
  // An invalid room code is a no-op, never a throw.
  assert.equal(writePasscode(storage, "nope", "x"), "");
  assert.equal(readPasscode(storage, "nope"), "");
});
