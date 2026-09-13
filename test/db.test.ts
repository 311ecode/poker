/**
 * test/db.test.ts — POKER-001b acceptance tests.
 *
 * Pure filesystem: no server, no dependencies. Every test gets its own
 * `mkdtemp` DATA_DIR. Run with `npm test` (`node --test`).
 *
 * The AC2/AC3/AC4 tests are the point of this ticket: one-mutation-one-file,
 * atomic temp+rename, and the per-room promise lock. Each was falsified by
 * deliberately breaking the implementation and watching it go red (see the
 * ticket report).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { TestContext } from "node:test";

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
  RoomCodeError,
  RoomCorruptError,
  RoomExistsError,
  RoomNotFoundError,
  RoomValidationError,
  generateRoomCode,
  openDb,
} from "../lib/db.ts";
import type { Ballot, CreateRoomInput, Member, Room, Vote } from "../lib/db.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODE_A = "AAAAAA";
const CODE_B = "BBBBBB";
const CODE_C = "CCCCCC";

/**
 * 10k `list()` sanity budget. There is no index by design, so `list()` reads
 * every room file: cost is linear in room count (~0.4s for 10k rooms measured
 * on the dev box, with LIST_CONCURRENCY=64). The budget is a tripwire against a
 * super-linear regression (e.g. re-reading each file per room), not a perf
 * claim; it carries ~10x headroom. Documented ceiling: at ~100k rooms a full
 * scan is multi-second, which is the point where an index would be justified.
 */
const LIST_10K_BUDGET_MS = 5_000;
const LIST_10K_ROOMS = 10_000;

async function makeTmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poker-db-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function roomsDirOf(dir: string): string {
  return join(dir, "rooms");
}

function roomPath(dir: string, code: string): string {
  return join(roomsDirOf(dir), `${code}.json`);
}

async function writeRawRoom(dir: string, name: string, contents: string): Promise<void> {
  await mkdir(roomsDirOf(dir), { recursive: true });
  await writeFile(join(roomsDirOf(dir), name), contents, "utf8");
}

function member(session: string, name: string, at = 1_757_800_000_000): Member {
  return { session, name, joinedAt: at, lastSeenAt: at };
}

function ballot(session: string, choice: string, at = 1_757_800_000_000): Ballot {
  return { session, choice, at };
}

function voteFixture(overrides: Partial<Vote> = {}): Vote {
  return {
    id: "v1",
    title: "Who pays the tab?",
    options: ["Bob", "Alice", "Split"],
    state: "open",
    createdAt: 1_757_800_100_000,
    closedAt: null,
    events: [{ at: 1_757_800_100_000, kind: "opened", by: "s-1" }],
    ballots: [],
    ...overrides,
  };
}

function roomFixture(code: string, overrides: Partial<Room> = {}): Room {
  return {
    code,
    title: `Room ${code}`,
    public: true,
    passcodeHash: null,
    createdAt: 1_757_800_000_000,
    members: [],
    votes: [],
    ...overrides,
  };
}

function createInput(title: string, overrides: Partial<CreateRoomInput> = {}): CreateRoomInput {
  return { title, ...overrides };
}

function codeFromIndex(index: number): string {
  const base = ROOM_CODE_ALPHABET.length;
  let remaining = index;
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code = ROOM_CODE_ALPHABET[remaining % base] + code;
    remaining = Math.floor(remaining / base);
  }
  return code;
}

/** Bounded-concurrency writer used only to seed the 10k-room timing test. */
async function seedManyRooms(dir: string, rooms: Room[]): Promise<void> {
  await mkdir(roomsDirOf(dir), { recursive: true });
  const limit = 64;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, rooms.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= rooms.length) return;
      const room = rooms[index];
      await writeFile(roomPath(dir, room.code), JSON.stringify(room, null, 2), "utf8");
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// AC1 — exact interface
// ---------------------------------------------------------------------------

describe("AC1 — openDb interface", () => {
  test("exposes get/list/create/mutate/remove/history and the typed error", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });

    assert.equal(typeof db.get, "function");
    assert.equal(typeof db.list, "function");
    assert.equal(typeof db.create, "function");
    assert.equal(typeof db.mutate, "function");
    assert.equal(typeof db.remove, "function");
    assert.equal(typeof db.history, "function");
    assert.equal(db.dir, dir);
    assert.equal(db.roomsDir, join(dir, "rooms"));
    assert.equal(typeof RoomCorruptError, "function");
  });

  test("create/get round-trips and writes pretty JSON at rooms/<CODE>.json", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });

    const created = await db.create(createInput("Friday night", { code: CODE_A }));
    assert.equal(created.code, CODE_A);

    const raw = await readFile(roomPath(dir, CODE_A), "utf8");
    assert.equal(raw, JSON.stringify(created, null, 2));
    assert.match(raw, /\n {2}"code": "AAAAAA",/);

    const loaded = await db.get(CODE_A);
    assert.deepStrictEqual(loaded, created);
  });

  test("get returns null for a missing room", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    assert.equal(await db.get(CODE_A), null);
  });

  test("get returns null for a malformed code instead of escaping the rooms dir", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    for (const bad of ["", "abc", "AAAAA", "AAAAAAA", "../../etc/passwd", "AAAAA/"]) {
      assert.equal(await db.get(bad), null, `get(${JSON.stringify(bad)})`);
    }
  });

  test("mutate/remove/create reject a malformed code with RoomCodeError", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await assert.rejects(() => db.mutate("bad", () => {}), RoomCodeError);
    await assert.rejects(() => db.remove("bad"), RoomCodeError);
    await assert.rejects(() => db.create(createInput("x", { code: "bad" })), RoomCodeError);
  });

  test("create can generate its own code (AC9)", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const created = await db.create(createInput("Generated"));
    assert.equal(created.code.length, 6);
    assert.match(created.code, ROOM_CODE_PATTERN);
    assert.notEqual(await db.get(created.code), null);
  });

  test("create rejects a taken code with RoomExistsError", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("One", { code: CODE_A }));
    await assert.rejects(() => db.create(createInput("Two", { code: CODE_A })), RoomExistsError);
  });

  test("create rejects an invalid room and writes nothing", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await assert.rejects(
      () => db.create(createInput("", { code: CODE_A, public: "yes" as unknown as boolean })),
      RoomValidationError,
    );
    assert.deepStrictEqual(await readdir(roomsDirOf(dir)).catch(() => []), []);
  });
});

// ---------------------------------------------------------------------------
// AC2 — one mutation writes exactly one file
// ---------------------------------------------------------------------------

describe("AC2 — one mutation writes exactly one file", () => {
  test("mutating A leaves B and C byte-identical with unchanged mtime", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });

    await db.create(createInput("A", { code: CODE_A }));
    await db.create(createInput("B", { code: CODE_B }));
    await db.create(createInput("C", { code: CODE_C }));

    const before = new Map<string, { mtimeMs: number; bytes: Buffer }>();
    for (const code of [CODE_A, CODE_B, CODE_C]) {
      const file = roomPath(dir, code);
      before.set(code, {
        mtimeMs: (await stat(file)).mtimeMs,
        bytes: await readFile(file),
      });
    }

    const mutated = await db.mutate(CODE_A, (room) => {
      room.title = "A changed";
      room.members.push(member("s-1", "Alice"));
    });
    assert.equal(mutated.title, "A changed");

    // A changed...
    const afterA = await readFile(roomPath(dir, CODE_A));
    assert.notDeepStrictEqual(afterA, before.get(CODE_A)!.bytes);

    // ...and B and C were not touched at all.
    for (const code of [CODE_B, CODE_C]) {
      const file = roomPath(dir, code);
      const snapshot = before.get(code)!;
      assert.equal((await stat(file)).mtimeMs, snapshot.mtimeMs, `${code} mtime changed`);
      assert.deepStrictEqual(await readFile(file), snapshot.bytes, `${code} content changed`);
    }
  });

  test("mutate refuses to write a different room's file", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    await db.create(createInput("B", { code: CODE_B }));
    const beforeB = await readFile(roomPath(dir, CODE_B));

    await assert.rejects(
      () => db.mutate(CODE_A, (room) => ({ ...room, code: CODE_B })),
      RoomValidationError,
    );

    assert.deepStrictEqual(await readFile(roomPath(dir, CODE_B)), beforeB);
    assert.equal((await db.get(CODE_A))!.title, "A");
  });
});

// ---------------------------------------------------------------------------
// AC3 — atomic temp file + rename
// ---------------------------------------------------------------------------

describe("AC3 — atomic write via .<CODE>.tmp + rename", () => {
  test("writes through the documented temp path and leaves no temp behind", async (t) => {
    const dir = await makeTmpDir(t);
    const seen: { code: string; tmpPath: string; targetPath: string }[] = [];
    const db = openDb({
      dir,
      __testHooks: {
        beforeRename: (info) => {
          seen.push(info);
          throw new Error("injected crash before rename");
        },
      },
    });

    await assert.rejects(
      () => db.create(createInput("A", { code: CODE_A })),
      /injected crash before rename/,
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, CODE_A);
    assert.equal(seen[0].tmpPath, join(roomsDirOf(dir), `.${CODE_A}.tmp`));
    assert.equal(seen[0].targetPath, roomPath(dir, CODE_A));

    // The crash happened after the temp write: the temp exists, the target does not.
    assert.deepStrictEqual(await readdir(roomsDirOf(dir)), [`.${CODE_A}.tmp`]);
    assert.equal(await db.get(CODE_A), null);
  });

  test("a crash between temp write and rename leaves the previous file intact", async (t) => {
    const dir = await makeTmpDir(t);
    const good = openDb({ dir });
    await good.create(
      createInput("Original", { code: CODE_A, members: [member("s-1", "Alice")] }),
    );
    const originalBytes = await readFile(roomPath(dir, CODE_A));

    let crashOnce = true;
    const crashing = openDb({
      dir,
      __testHooks: {
        beforeRename: () => {
          if (crashOnce) {
            crashOnce = false;
            throw new Error("boom: process died before rename");
          }
        },
      },
    });

    await assert.rejects(
      () => crashing.mutate(CODE_A, (room) => {
        room.title = "half-written";
        room.members = [];
      }),
      /boom: process died before rename/,
    );

    // AC3: the old file is still there, byte-identical and parseable.
    assert.deepStrictEqual(await readFile(roomPath(dir, CODE_A)), originalBytes);
    const survived = await good.get(CODE_A);
    assert.equal(survived!.title, "Original");
    assert.deepStrictEqual(survived!.members.map((m) => m.name), ["Alice"]);

    // And a subsequent clean write succeeds.
    const repaired = await good.mutate(CODE_A, (room) => {
      room.title = "Repaired";
    });
    assert.equal(repaired.title, "Repaired");
    assert.equal((await good.get(CODE_A))!.title, "Repaired");
  });

  test("readers ignore a stale .tmp file left by a crash", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    await writeRawRoom(dir, `.${CODE_A}.tmp`, "{ this is not json");

    const listing = await db.list();
    assert.deepStrictEqual(listing.corrupt, { count: 0, names: [] });
    assert.equal(listing.rooms.length, 1);
    assert.equal((await db.get(CODE_A))!.title, "A");
  });
});

// ---------------------------------------------------------------------------
// AC4 — serialized per room, parallel across rooms
// ---------------------------------------------------------------------------

describe("AC4 — per-code lock", () => {
  test("50 concurrent mutate('A') apply sequentially in call order (no lost writes)", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));

    const applied: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        db.mutate(CODE_A, async (room) => {
          // Yield, so an unlocked implementation would interleave here.
          await new Promise((resolve) => setImmediate(resolve));
          applied.push(index);
          room.members.push(member(`s-${index}`, `m${index}`));
        }),
      ),
    );

    assert.deepStrictEqual(
      applied,
      Array.from({ length: 50 }, (_unused, index) => index),
      "mutations were not applied in call order",
    );

    const room = await db.get(CODE_A);
    assert.equal(room!.members.length, 50, "lost writes: the lock did not serialize");
    assert.deepStrictEqual(
      room!.members.map((m) => m.session),
      Array.from({ length: 50 }, (_unused, index) => `s-${index}`),
    );
  });

  test("mutate('A') and mutate('B') genuinely overlap", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    await db.create(createInput("B", { code: CODE_B }));

    const aEntered = Promise.withResolvers<void>();
    const aGate = Promise.withResolvers<void>();
    let aInFlight = false;

    const pA = db.mutate(CODE_A, async (room) => {
      aInFlight = true;
      aEntered.resolve();
      await aGate.promise;
      aInFlight = false;
      room.title = "A mutated";
    });

    await aEntered.promise;

    let bRanWhileAInFlight = false;
    const pB = db.mutate(CODE_B, (room) => {
      bRanWhileAInFlight = aInFlight;
      room.title = "B mutated";
    });

    // If there were one global lock, pB could not settle until pA does.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("mutate('B') was blocked by mutate('A'): rooms are not parallel")),
        2_000,
      );
    });
    await Promise.race([pB, timeout]);
    clearTimeout(timer);

    assert.equal(bRanWhileAInFlight, true, "B did not run while A was in flight");
    assert.equal(aInFlight, true, "A finished before B ran, so they did not overlap");

    aGate.resolve();
    await pA;

    assert.equal((await db.get(CODE_A))!.title, "A mutated");
    assert.equal((await db.get(CODE_B))!.title, "B mutated");
  });
});

// ---------------------------------------------------------------------------
// AC5 — corruption fails loud
// ---------------------------------------------------------------------------

describe("AC5 — corruption fails loud", () => {
  test("get throws RoomCorruptError for unparseable JSON", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await writeRawRoom(dir, `${CODE_A}.json`, "{ definitely not json");

    await assert.rejects(
      () => db.get(CODE_A),
      (error: unknown) => {
        assert.ok(error instanceof RoomCorruptError, "not a RoomCorruptError");
        assert.equal(error.code, CODE_A);
        assert.match(error.message, /invalid JSON/);
        return true;
      },
    );
  });

  test("get throws RoomCorruptError for a schema-invalid room", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const invalid = { ...roomFixture(CODE_A), public: "yes" };
    await writeRawRoom(dir, `${CODE_A}.json`, JSON.stringify(invalid));

    await assert.rejects(() => db.get(CODE_A), RoomCorruptError);
  });

  test("get throws RoomCorruptError when the room's code does not match its file name", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await writeRawRoom(dir, `${CODE_A}.json`, JSON.stringify(roomFixture(CODE_B)));

    await assert.rejects(
      () => db.get(CODE_A),
      (error: unknown) => {
        assert.ok(error instanceof RoomCorruptError);
        assert.match(error.message, /does not match file name/);
        return true;
      },
    );
  });

  test("list skips corrupt files and reports count + names", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("Good", { code: CODE_A }));
    await writeRawRoom(dir, `${CODE_B}.json`, "{ nope");
    await writeRawRoom(dir, `${CODE_C}.json`, JSON.stringify({ code: CODE_C, title: "missing fields" }));

    const listing = await db.list();
    assert.deepStrictEqual(listing.rooms.map((r) => r.code), [CODE_A]);
    assert.equal(listing.corrupt.count, 2);
    assert.deepStrictEqual(listing.corrupt.names, [`${CODE_B}.json`, `${CODE_C}.json`]);
  });

  test("list ignores non-room files and the rooms dir need not exist", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });

    const empty = await db.list();
    assert.deepStrictEqual(empty, { rooms: [], corrupt: { count: 0, names: [] } });

    await writeRawRoom(dir, "README.txt", "not a room");
    await writeRawRoom(dir, "notes.json", "{}");
    await db.create(createInput("A", { code: CODE_A }));

    const listing = await db.list();
    assert.deepStrictEqual(listing.rooms.map((r) => r.code), [CODE_A]);
    assert.deepStrictEqual(listing.corrupt, { count: 0, names: [] });
  });
});

// ---------------------------------------------------------------------------
// AC6 — validation on load and on mutate
// ---------------------------------------------------------------------------

describe("AC6 — validation on load and on mutate", () => {
  const invalidMutators: Array<[string, (room: Room) => void]> = [
    ["code too short", (room) => { room.code = "BAD"; }],
    ["code lowercase", (room) => { room.code = "aaaaaa"; }],
    ["vote state not open/closed", (room) => { room.votes = [voteFixture({ state: "paused" as unknown as "open" })]; }],
    ["empty options", (room) => { room.votes = [voteFixture({ options: [] })]; }],
    ["blank option", (room) => { room.votes = [voteFixture({ options: ["Bob", ""] })]; }],
    [
      "duplicate ballot session in one vote",
      (room) => {
        room.votes = [
          voteFixture({ ballots: [ballot("s-1", "Bob"), ballot("s-1", "Alice")] }),
        ];
      },
    ],
    ["public not boolean", (room) => { room.public = "true" as unknown as boolean; }],
  ];

  for (const [label, mutateFn] of invalidMutators) {
    test(`mutate rejects invalid room (${label}) and leaves the file untouched`, async (t) => {
      const dir = await makeTmpDir(t);
      const db = openDb({ dir });
      await db.create(createInput("A", { code: CODE_A }));
      const before = await readFile(roomPath(dir, CODE_A));

      await assert.rejects(() => db.mutate(CODE_A, mutateFn), RoomValidationError);

      assert.deepStrictEqual(await readFile(roomPath(dir, CODE_A)), before);
      assert.equal((await db.get(CODE_A))!.title, "A");
    });
  }

  test("mutate rejects a mutator that returns a non-room", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    const before = await readFile(roomPath(dir, CODE_A));

    await assert.rejects(
      () => db.mutate(CODE_A, () => "not a room" as unknown as Room),
      RoomValidationError,
    );
    assert.deepStrictEqual(await readFile(roomPath(dir, CODE_A)), before);
  });

  test("a mutator that throws leaves the file untouched", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    const before = await readFile(roomPath(dir, CODE_A));

    await assert.rejects(
      () => db.mutate(CODE_A, (room) => {
        room.title = "dirty draft";
        throw new Error("nope");
      }),
      /nope/,
    );
    assert.deepStrictEqual(await readFile(roomPath(dir, CODE_A)), before);
  });

  test("loading a file with duplicate ballot sessions throws RoomCorruptError", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const invalid = roomFixture(CODE_A, {
      votes: [
        voteFixture({
          ballots: [ballot("s-1", "Bob"), ballot("s-1", "Alice")],
        }),
      ],
    });
    await writeRawRoom(dir, `${CODE_A}.json`, JSON.stringify(invalid));

    await assert.rejects(
      () => db.get(CODE_A),
      (error: unknown) => {
        assert.ok(error instanceof RoomCorruptError);
        assert.ok(
          error.issues.some((issue) => issue.includes("duplicated")),
          `expected a duplicated-session issue, got: ${error.issues.join("; ")}`,
        );
        return true;
      },
    );
  });

  test("loading tolerates unknown extra keys", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const extra = { ...roomFixture(CODE_A), derivedCounts: { Bob: 1 } };
    await writeRawRoom(dir, `${CODE_A}.json`, JSON.stringify(extra));
    const loaded = await db.get(CODE_A);
    assert.equal(loaded!.code, CODE_A);
  });

  test("mutate on an unknown room throws RoomNotFoundError", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await assert.rejects(() => db.mutate(CODE_A, () => {}), RoomNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// AC7 — list projection, never the hash
// ---------------------------------------------------------------------------

describe("AC7 — list projection", () => {
  test("returns only public rooms, projected, without the passcode hash", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const HASH = "$2b$10$super-secret-hash-value";

    await db.create(createInput("Public", { code: CODE_A, public: true }));
    await db.create(createInput("Private", { code: CODE_B, public: false }));
    await db.create(
      createInput("Locked", {
        code: CODE_C,
        public: true,
        passcodeHash: HASH,
        members: [member("s-1", "Alice"), member("s-2", "Bob")],
      }),
    );

    const listing = await db.list();
    assert.deepStrictEqual(listing.rooms.map((r) => r.code), [CODE_A, CODE_C]);
    assert.deepStrictEqual(listing.rooms, [
      { code: CODE_A, title: "Public", members: 0, hasPasscode: false },
      { code: CODE_C, title: "Locked", members: 2, hasPasscode: true },
    ]);

    for (const summary of listing.rooms) {
      assert.deepStrictEqual(Object.keys(summary).sort(), ["code", "hasPasscode", "members", "title"]);
    }
    assert.equal(JSON.stringify(listing).includes(HASH), false, "the passcode hash leaked");
    assert.equal(JSON.stringify(listing).includes("passcodeHash"), false);
  });

  test("public:true and a missing-ish passcodeHash both report hasPasscode false", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("Empty hash", { code: CODE_A, passcodeHash: "" }));
    const listing = await db.list();
    assert.equal(listing.rooms[0].hasPasscode, false);
  });
});

// ---------------------------------------------------------------------------
// AC8 — history projection / R1-R2 at the DB boundary
// ---------------------------------------------------------------------------

describe("AC8 — history projection", () => {
  async function seedHistory(t: TestContext) {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    const members = [member("s-1", "Alice"), member("s-2", "Bob"), member("s-3", "Carol")];
    // Option labels deliberately differ from member names, so a leaked member
    // name cannot hide behind a legitimately public option label.
    const options = ["Pizza", "Sushi", "Tacos"];
    const openVote = voteFixture({
      id: "v1",
      options,
      ballots: [ballot("s-1", "Pizza"), ballot("s-2", "Pizza"), ballot("s-3", "Tacos")],
    });
    const closedVote = voteFixture({
      id: "v2",
      title: "Closed one",
      options,
      state: "closed",
      createdAt: 1_757_800_200_000,
      closedAt: 1_757_800_300_000,
      events: [
        { at: 1_757_800_200_000, kind: "opened", by: "s-1" },
        { at: 1_757_800_300_000, kind: "closed", by: "s-2" },
      ],
      ballots: [ballot("s-1", "Sushi"), ballot("s-2", "Tacos")],
    });
    await db.create(
      createInput("History", { code: CODE_A, members, votes: [openVote, closedVote] }),
    );
    return { db, openVote, closedVote };
  }

  test("open votes expose counts only — no name, reveal, result or ballots", async (t) => {
    const { db } = await seedHistory(t);
    const [open] = await db.history(CODE_A);

    assert.equal(open.state, "open");
    assert.deepStrictEqual(open.counts, { Pizza: 2, Sushi: 0, Tacos: 1 });
    assert.equal(open.votedCount, 3);
    assert.equal(open.events.length, 1);
    assert.equal(open.closedAt, null);

    for (const forbidden of ["reveal", "result", "ballots", "name", "names"]) {
      assert.equal(Object.hasOwn(open, forbidden), false, `open vote exposed "${forbidden}"`);
    }
    const serialized = JSON.stringify(open);
    for (const name of ["Alice", "Bob", "Carol"]) {
      assert.equal(serialized.includes(name), false, `open vote leaked member name ${name}`);
    }
    assert.equal(serialized.includes('"choice"'), false, "open vote leaked a ballot choice");
    assert.equal(serialized.includes('"session"'), false, "open vote leaked a ballot session");
  });

  test("closed votes expose result and reveal with member names", async (t) => {
    const { db } = await seedHistory(t);
    const [, closed] = await db.history(CODE_A);

    assert.equal(closed.state, "closed");
    assert.equal(closed.closedAt, 1_757_800_300_000);
    assert.deepStrictEqual(closed.result, { Pizza: 0, Sushi: 1, Tacos: 1 });
    assert.deepStrictEqual(closed.reveal, [
      { name: "Alice", choice: "Sushi" },
      { name: "Bob", choice: "Tacos" },
    ]);
    assert.equal(closed.votedCount, 2);
    assert.equal(closed.events.length, 2);
    assert.equal(Object.hasOwn(closed, "ballots"), false);
  });

  test("history throws RoomNotFoundError for an unknown or malformed room", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await assert.rejects(() => db.history(CODE_A), RoomNotFoundError);
    await assert.rejects(() => db.history("nope"), RoomNotFoundError);
  });

  test("history throws RoomCorruptError for a corrupt room", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await writeRawRoom(dir, `${CODE_A}.json`, "{ nope");
    await assert.rejects(() => db.history(CODE_A), RoomCorruptError);
  });
});

// ---------------------------------------------------------------------------
// AC9 — room code generator
// ---------------------------------------------------------------------------

describe("AC9 — room code generator", () => {
  test("alphabet is 6 long, uppercase/digits, and excludes ambiguous glyphs", () => {
    assert.equal(ROOM_CODE_LENGTH, 6);
    assert.match(ROOM_CODE_ALPHABET, /^[A-Z0-9]+$/);
    assert.equal(new Set(ROOM_CODE_ALPHABET).size, ROOM_CODE_ALPHABET.length, "duplicate symbol");
    for (const glyph of ["0", "O", "1", "I", "L"]) {
      assert.equal(
        ROOM_CODE_ALPHABET.includes(glyph),
        false,
        `ambiguous glyph ${glyph} is in the alphabet`,
      );
    }
  });

  test("generated codes are 6 chars, match the pattern and only use the alphabet", () => {
    for (let i = 0; i < 2_000; i++) {
      const code = generateRoomCode();
      assert.equal(code.length, 6);
      assert.match(code, ROOM_CODE_PATTERN);
      for (const glyph of code) {
        assert.ok(ROOM_CODE_ALPHABET.includes(glyph), `unexpected glyph ${glyph} in ${code}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC10 — DATA_DIR
// ---------------------------------------------------------------------------

describe("AC10 — DATA_DIR", () => {
  const original = process.env.DATA_DIR;
  after(() => {
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
  });

  test("DATA_DIR overrides the default data/ directory", async (t) => {
    const dir = await makeTmpDir(t);
    process.env.DATA_DIR = dir;
    const db = openDb();
    assert.equal(db.dir, dir);
    assert.equal(db.roomsDir, join(dir, "rooms"));

    const created = await db.create(createInput("From env"));
    assert.deepStrictEqual(await readdir(roomsDirOf(dir)), [`${created.code}.json`]);
  });

  test("openDb({ dir }) takes precedence over DATA_DIR", async (t) => {
    const envDir = await makeTmpDir(t);
    const explicitDir = await makeTmpDir(t);
    process.env.DATA_DIR = envDir;

    const db = openDb({ dir: explicitDir });
    assert.equal(db.dir, explicitDir);
    await db.create(createInput("Explicit"));
    assert.deepStrictEqual(await readdir(envDir).catch(() => []), []);
    assert.equal((await readdir(roomsDirOf(explicitDir))).length, 1);
  });

  test("no caching: an external write is visible to the next get()", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    const first = await db.get(CODE_A);
    assert.equal(first!.title, "A");

    await writeRawRoom(dir, `${CODE_A}.json`, JSON.stringify(roomFixture(CODE_A, { title: "External" })));
    assert.equal((await db.get(CODE_A))!.title, "External");
  });

  test("get returns a fresh object each call (mutating it does not corrupt the db)", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));
    const first = await db.get(CODE_A);
    first!.title = "hacked in memory";
    first!.members.push(member("s-x", "Mallory"));
    const second = await db.get(CODE_A);
    assert.equal(second!.title, "A");
    assert.deepStrictEqual(second!.members, []);
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  test("deletes the room file and is idempotent", async (t) => {
    const dir = await makeTmpDir(t);
    const db = openDb({ dir });
    await db.create(createInput("A", { code: CODE_A }));

    assert.equal(await db.remove(CODE_A), true);
    assert.equal(await db.get(CODE_A), null);
    assert.deepStrictEqual(await readdir(roomsDirOf(dir)), []);
    assert.equal(await db.remove(CODE_A), false);
  });
});

// ---------------------------------------------------------------------------
// 10k-room list() timing sanity check
// ---------------------------------------------------------------------------

describe("10k-room list() timing (documented ceiling)", () => {
  test(`list() over ${LIST_10K_ROOMS} rooms stays under ${LIST_10K_BUDGET_MS}ms`, async (t) => {
    const dir = await makeTmpDir(t);
    const rooms: Room[] = [];
    for (let i = 0; i < LIST_10K_ROOMS; i++) {
      const code = codeFromIndex(i);
      rooms.push(
        roomFixture(code, {
          title: `Room ${i}`,
          public: i % 2 === 0,
          members: [member("s-1", "Alice"), member("s-2", "Bob")],
        }),
      );
    }

    const seededAt = performance.now();
    await seedManyRooms(dir, rooms);
    const seedMs = performance.now() - seededAt;

    const db = openDb({ dir });
    const startedAt = performance.now();
    const listing = await db.list();
    const elapsedMs = performance.now() - startedAt;

    t.diagnostic(
      `list(): ${listing.rooms.length} public rooms in ${elapsedMs.toFixed(0)}ms ` +
        `(seed ${LIST_10K_ROOMS} files in ${seedMs.toFixed(0)}ms; budget ${LIST_10K_BUDGET_MS}ms)`,
    );

    assert.equal(listing.rooms.length, LIST_10K_ROOMS / 2);
    assert.deepStrictEqual(listing.corrupt, { count: 0, names: [] });
    assert.ok(
      elapsedMs < LIST_10K_BUDGET_MS,
      `list() took ${elapsedMs.toFixed(0)}ms for ${LIST_10K_ROOMS} rooms (budget ${LIST_10K_BUDGET_MS}ms)`,
    );
  });
});
