/**
 * lib/db.ts — POKER-001b: the room-file database.
 *
 * The whole database is one JSON file per room: `<DATA_DIR>/rooms/<CODE>.json`
 * (parent ticket POKER-001 §1.1). There is no index, no journal, no event log
 * and no DB engine. This module is self-contained: `node:fs/promises`,
 * `node:path`, `node:crypto` only — **zero runtime dependencies**.
 *
 * Guarantees this module exists to provide
 * ----------------------------------------
 * - **`mutate` is the only write path.** `mutate(code, fn)` reads only that
 *   room, validates the result, and atomically replaces only that room's file;
 *   no other room's file is touched (AC2). `create()` and `remove()` merely
 *   add or delete a whole room file and never change an existing one in place,
 *   so there is no other way for a caller to modify a room.
 * - **Atomic writes.** The new bytes are written to `rooms/.<CODE>.tmp` and
 *   then `rename()`d over `rooms/<CODE>.json`. `rename` is atomic within one
 *   filesystem, so the temp file lives in the same directory. A crash between
 *   the temp write and the rename leaves the previous room file intact and
 *   parseable; a stale `.tmp` may be left behind, and every reader ignores it
 *   (AC3).
 * - **Serialized per room, parallel across rooms.** `mutate` chains on a
 *   per-code promise lock: same-code calls apply in call order (FIFO), while
 *   different codes run concurrently (AC4).
 * - **Corruption fails loud.** `get()`/`history()` throw `RoomCorruptError`;
 *   `list()` skips corrupt room files *and reports* them (count + file names)
 *   instead of hiding them (AC5).
 * - **Validation on load and on mutate** (AC6). A rejected mutation writes
 *   nothing — the file is left byte-identical.
 * - **No caching.** Every read parses the file again. A stale in-memory cache
 *   would reintroduce the lost-write bug this ticket exists to prevent. The
 *   only per-room state is the promise lock, which is dropped once it drains.
 *
 * Write volume / cost
 * -------------------
 * One `mutate` = one `readFile` + one `writeFile` (temp) + one `rename` +
 * one `unlink` by the rename, i.e. O(1) in the number of rooms and independent
 * of room count. Frequent writes such as a `lastSeenAt` presence bump therefore
 * cost one small write of that room's file only; unrelated rooms are neither
 * read nor re-validated. `list()` is the only O(N)-rooms operation and reads
 * every room file (no index by design); readers never write.
 *
 * `list()` result shape
 * ---------------------
 * `list()` returns `{ rooms, corrupt }`, where `rooms` contains only rooms with
 * `public !== false`, projected to `{ code, title, members, hasPasscode }`
 * (`members` is a count; `passcodeHash` is never exposed, AC7), and `corrupt`
 * is `{ count, names }` with the file names that failed to parse/validate.
 * `rooms` is sorted by `code` for determinism.
 *
 * History and the R1/R2 invariant (AC8)
 * -------------------------------------
 * `history(code)` projects every vote. CLOSED votes carry `result` (counts) and
 * `reveal` (`[{name, choice}]`). OPEN votes carry aggregate `counts` and
 * `votedCount` only: the projection never contains `ballots`, `reveal`,
 * `result` or a member name for an open vote, so a caller cannot leak who voted
 * what while a vote is open.
 *
 * Data directory (AC10)
 * ---------------------
 * `openDb({ dir })` uses the given directory verbatim (resolved to an absolute
 * path); when `dir` is omitted it falls back to the `DATA_DIR` environment
 * variable and finally to `./data`. Room files live in `<dir>/rooms/`.
 *
 * Test-only seam (AC3)
 * --------------------
 * `openDb({ dir, __testHooks: { beforeRename } })` runs `beforeRename` after the
 * temp file is written and before the `rename()`. Throwing from it simulates a
 * crash at exactly the dangerous point. It is test-only: production code must
 * not pass `__testHooks`.
 */

import { randomInt } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Room codes (AC9)
// ---------------------------------------------------------------------------

/** Codes are exactly this many characters (contract §1.1). */
export const ROOM_CODE_LENGTH = 6;

/**
 * Uppercase letters and digits with the ambiguous glyphs removed:
 * no `0` (vs `O`), no `1` (vs `I`/`L`), and therefore no `O`, `I` or `L`.
 * 31 symbols, so `crypto.randomInt` gives a uniform draw.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The shape validation enforces for a room code. */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** `rooms/<CODE>.json` — the only files `list()` considers room files. */
const ROOM_FILE_PATTERN = /^([A-Z0-9]{6})\.json$/;

/** How many generated codes `create()` tries before giving up on a collision. */
const CREATE_CODE_ATTEMPTS = 100;

/** Bounded parallelism for `list()` so 10k rooms do not exhaust file handles. */
const LIST_CONCURRENCY = 64;

/** Generate a fresh room code from the ambiguous-glyph-free alphabet. */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

// ---------------------------------------------------------------------------
// Schema (parent POKER-001 §1.1 — frozen)
// ---------------------------------------------------------------------------

export type VoteState = "open" | "closed";
export type VoteEventKind = "opened" | "closed" | "reopened";

export interface Member {
  session: string;
  name: string;
  joinedAt: number;
  lastSeenAt: number;
}

export interface VoteEvent {
  at: number;
  kind: VoteEventKind;
  by: string;
}

/** One ballot per session; last write wins while the vote is open. */
export interface Ballot {
  session: string;
  choice: string;
  at: number;
}

export interface Vote {
  id: string;
  title: string;
  options: string[];
  state: VoteState;
  createdAt: number;
  closedAt: number | null;
  events: VoteEvent[];
  ballots: Ballot[];
}

/** The complete contents of one `rooms/<CODE>.json` file. */
export interface Room {
  code: string;
  title: string;
  public: boolean;
  passcodeHash: string | null;
  createdAt: number;
  members: Member[];
  votes: Vote[];
}

/** What a caller supplies to `create()`; only `title` is required. */
export interface CreateRoomInput {
  code?: string;
  title: string;
  public?: boolean;
  passcodeHash?: string | null;
  createdAt?: number;
  members?: Member[];
  votes?: Vote[];
}

/** `list()` projection of one public room (AC7) — never the hash. */
export interface RoomSummary {
  code: string;
  title: string;
  members: number;
  hasPasscode: boolean;
}

/** Corrupt room files that `list()` skipped and is reporting (AC5). */
export interface CorruptReport {
  count: number;
  names: string[];
}

export interface RoomListing {
  rooms: RoomSummary[];
  corrupt: CorruptReport;
}

/** One entry of `history()`'s closed-vote reveal (AC8). */
export interface HistoryRevealEntry {
  name: string;
  choice: string;
}

/**
 * `history()` projection of one vote. `result` and `reveal` exist ONLY for
 * closed votes; open votes never carry `ballots`, `reveal`, `result` or names.
 */
export interface HistoryVote {
  id: string;
  title: string;
  options: string[];
  state: VoteState;
  createdAt: number;
  closedAt: number | null;
  events: VoteEvent[];
  counts: Record<string, number>;
  votedCount: number;
  result?: Record<string, number>;
  reveal?: HistoryRevealEntry[];
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** A room file exists but is unparseable or fails schema validation (AC5). */
export class RoomCorruptError extends Error {
  code: string;
  file: string;
  issues: string[];

  constructor(code: string, file: string, issues: string[]) {
    const detail = issues.length > 0 ? `: ${issues.join("; ")}` : "";
    super(`room ${code} is corrupt (${file})${detail}`);
    this.name = "RoomCorruptError";
    this.code = code;
    this.file = file;
    this.issues = issues;
  }
}

/** The requested room file does not exist. */
export class RoomNotFoundError extends Error {
  code: string;

  constructor(code: string) {
    super(`room ${code} does not exist`);
    this.name = "RoomNotFoundError";
    this.code = code;
  }
}

/** `create()` was asked for a code that is already taken. */
export class RoomExistsError extends Error {
  code: string;

  constructor(code: string) {
    super(`room ${code} already exists`);
    this.name = "RoomExistsError";
    this.code = code;
  }
}

/** A room failed schema validation, or a mutation would violate an invariant. */
export class RoomValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`room failed validation: ${issues.join("; ")}`);
    this.name = "RoomValidationError";
    this.issues = issues;
  }
}

/** A code argument is not `/^[A-Z0-9]{6}$/`. */
export class RoomCodeError extends Error {
  code: string;

  constructor(code: unknown) {
    super(`invalid room code: ${JSON.stringify(code)} (expected /^[A-Z0-9]{6}$/)`);
    this.name = "RoomCodeError";
    this.code = String(code);
  }
}

// ---------------------------------------------------------------------------
// Validation (AC6)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateMember(value: unknown, index: number, issues: string[]): void {
  const at = `members[${index}]`;
  if (!isPlainObject(value)) {
    issues.push(`${at} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.session)) issues.push(`${at}.session must be a non-empty string`);
  if (typeof value.name !== "string") issues.push(`${at}.name must be a string`);
  if (!isFiniteNumber(value.joinedAt)) issues.push(`${at}.joinedAt must be a finite number`);
  if (!isFiniteNumber(value.lastSeenAt)) issues.push(`${at}.lastSeenAt must be a finite number`);
}

function validateVote(value: unknown, index: number, issues: string[]): void {
  const at = `votes[${index}]`;
  if (!isPlainObject(value)) {
    issues.push(`${at} must be an object`);
    return;
  }
  if (!isNonEmptyString(value.id)) issues.push(`${at}.id must be a non-empty string`);
  if (typeof value.title !== "string") issues.push(`${at}.title must be a string`);

  if (!Array.isArray(value.options) || value.options.length === 0) {
    issues.push(`${at}.options must be a non-empty array`);
  } else {
    value.options.forEach((option, optionIndex) => {
      if (!isNonEmptyString(option)) {
        issues.push(`${at}.options[${optionIndex}] must be a non-empty string`);
      }
    });
  }

  if (value.state !== "open" && value.state !== "closed") {
    issues.push(`${at}.state must be "open" or "closed"`);
  }
  if (!isFiniteNumber(value.createdAt)) issues.push(`${at}.createdAt must be a finite number`);
  if (value.closedAt !== null && !isFiniteNumber(value.closedAt)) {
    issues.push(`${at}.closedAt must be a finite number or null`);
  }

  if (!Array.isArray(value.events)) {
    issues.push(`${at}.events must be an array`);
  } else {
    value.events.forEach((event, eventIndex) => {
      const eventAt = `${at}.events[${eventIndex}]`;
      if (!isPlainObject(event)) {
        issues.push(`${eventAt} must be an object`);
        return;
      }
      if (!isFiniteNumber(event.at)) issues.push(`${eventAt}.at must be a finite number`);
      if (event.kind !== "opened" && event.kind !== "closed" && event.kind !== "reopened") {
        issues.push(`${eventAt}.kind must be "opened", "closed" or "reopened"`);
      }
      if (!isNonEmptyString(event.by)) issues.push(`${eventAt}.by must be a non-empty string`);
    });
  }

  if (!Array.isArray(value.ballots)) {
    issues.push(`${at}.ballots must be an array`);
  } else {
    // One ballot per session per vote — the session key must be unique (AC6).
    const seenSessions = new Set<string>();
    value.ballots.forEach((ballot, ballotIndex) => {
      const ballotAt = `${at}.ballots[${ballotIndex}]`;
      if (!isPlainObject(ballot)) {
        issues.push(`${ballotAt} must be an object`);
        return;
      }
      if (!isNonEmptyString(ballot.session)) {
        issues.push(`${ballotAt}.session must be a non-empty string`);
      } else if (seenSessions.has(ballot.session)) {
        issues.push(`${ballotAt}.session "${ballot.session}" is duplicated`);
      } else {
        seenSessions.add(ballot.session);
      }
      if (!isNonEmptyString(ballot.choice)) issues.push(`${ballotAt}.choice must be a non-empty string`);
      if (!isFiniteNumber(ballot.at)) issues.push(`${ballotAt}.at must be a finite number`);
    });
  }
}

/**
 * Validate an untrusted value against the frozen §1.1 schema. Returns the list
 * of problems (empty = valid) so callers can attach them to a typed error.
 */
export function validateRoom(value: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(value)) return ["room is not a JSON object"];

  if (!isNonEmptyString(value.code) || !ROOM_CODE_PATTERN.test(value.code)) {
    issues.push("code must match /^[A-Z0-9]{6}$/");
  }
  if (typeof value.title !== "string") issues.push("title must be a string");
  if (typeof value.public !== "boolean") issues.push("public must be a boolean");
  if (value.passcodeHash !== null && typeof value.passcodeHash !== "string") {
    issues.push("passcodeHash must be a string or null");
  }
  if (!isFiniteNumber(value.createdAt)) issues.push("createdAt must be a finite number");

  if (!Array.isArray(value.members)) {
    issues.push("members must be an array");
  } else {
    value.members.forEach((member, index) => validateMember(member, index, issues));
  }

  if (!Array.isArray(value.votes)) {
    issues.push("votes must be an array");
  } else {
    const seenVoteIds = new Set<string>();
    value.votes.forEach((vote, index) => {
      validateVote(vote, index, issues);
      if (isPlainObject(vote) && isNonEmptyString(vote.id)) {
        if (seenVoteIds.has(vote.id)) issues.push(`votes[${index}].id "${vote.id}" is duplicated`);
        else seenVoteIds.add(vote.id);
      }
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Public types for the database handle
// ---------------------------------------------------------------------------

/** Test-only seam. Production callers must not use it. */
export interface DbTestHooks {
  /**
   * Called after the temp file has been written and before `rename()` replaces
   * the target. Throwing here simulates a crash between the two (AC3).
   */
  beforeRename?: (info: {
    code: string;
    tmpPath: string;
    targetPath: string;
    data: string;
  }) => void | Promise<void>;
}

export interface OpenDbOptions {
  /** Base data directory; `rooms/` is created inside it. Defaults to `DATA_DIR` or `./data`. */
  dir?: string;
  /** Test-only failure injection. */
  __testHooks?: DbTestHooks;
}

/** A mutation of one room. Return a new room, or mutate in place and return nothing. */
export type RoomMutator = (room: Room) => Room | void | Promise<Room | void>;

export interface Db {
  /** Resolved base data directory. */
  readonly dir: string;
  /** `<dir>/rooms` — where the room files live. */
  readonly roomsDir: string;
  /** Parse one room; `null` when absent. Throws `RoomCorruptError` on bad content. */
  get(code: string): Promise<Room | null>;
  /** Public rooms (projected) plus a report of corrupt files. */
  list(): Promise<RoomListing>;
  /** Create a room (generating a code when none is given). */
  create(input: CreateRoomInput): Promise<Room>;
  /** The only path that changes an existing room. */
  mutate(code: string, fn: RoomMutator): Promise<Room>;
  /** Delete a room file; `true` when a file was removed. */
  remove(code: string): Promise<boolean>;
  /** Anonymity-safe vote history (AC8). */
  history(code: string): Promise<HistoryVote[]>;
}

/** Base data directory: `DATA_DIR` when set and non-empty, else `./data`. */
export function defaultDataDir(): string {
  const fromEnv = process.env.DATA_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve("data");
}

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------

export function openDb(options: OpenDbOptions = {}): Db {
  const dir =
    typeof options.dir === "string" && options.dir.trim() !== ""
      ? resolve(options.dir)
      : defaultDataDir();
  const roomsDir = join(dir, "rooms");
  const hooks: DbTestHooks = options.__testHooks ?? {};

  // Per-code promise lock: same code chains FIFO, different codes are parallel.
  // The map holds only settled-swallowing tails; each removes itself once it
  // drains, so the map stays tiny.
  const locks = new Map<string, Promise<void>>();

  function withLock<T>(code: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(code) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail: Promise<void> = run.then(
      () => {
        if (locks.get(code) === tail) locks.delete(code);
      },
      () => {
        if (locks.get(code) === tail) locks.delete(code);
      },
    );
    locks.set(code, tail);
    return run;
  }

  function roomFile(code: string): string {
    return join(roomsDir, `${code}.json`);
  }

  function assertCode(code: unknown): asserts code is string {
    if (typeof code !== "string" || !ROOM_CODE_PATTERN.test(code)) {
      throw new RoomCodeError(code);
    }
  }

  /** Parse a room file. `null` when the file does not exist; throws when bad. */
  async function parseRoomFile(code: string, file: string, raw: string): Promise<Room> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RoomCorruptError(code, file, [`invalid JSON: ${message}`]);
    }
    const issues = validateRoom(parsed);
    if (issues.length > 0) throw new RoomCorruptError(code, file, issues);
    const room = parsed as Room;
    if (room.code !== code) {
      throw new RoomCorruptError(code, file, [
        `code "${room.code}" does not match file name "${code}.json"`,
      ]);
    }
    return room;
  }

  async function readRoom(code: string): Promise<Room | null> {
    const file = roomFile(code);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    return parseRoomFile(code, file, raw);
  }

  /**
   * AC2/AC3: exactly one room file is replaced; new bytes land in
   * `rooms/.<CODE>.tmp` first and `rename()` swaps them in atomically.
   */
  async function writeRoomAtomic(room: Room): Promise<void> {
    await mkdir(roomsDir, { recursive: true });
    const targetPath = roomFile(room.code);
    const tmpPath = join(roomsDir, `.${room.code}.tmp`);
    const data = JSON.stringify(room, null, 2);
    await writeFile(tmpPath, data, "utf8");
    if (hooks.beforeRename) {
      await hooks.beforeRename({ code: room.code, tmpPath, targetPath, data });
    }
    await rename(tmpPath, targetPath);
  }

  async function get(code: string): Promise<Room | null> {
    // A malformed code can never name an existing room; treat it as absent so a
    // caller never has to catch for hostile input, and never build a path from it.
    if (typeof code !== "string" || !ROOM_CODE_PATTERN.test(code)) return null;
    return readRoom(code);
  }

  async function list(): Promise<RoomListing> {
    let entries;
    try {
      entries = await readdir(roomsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { rooms: [], corrupt: { count: 0, names: [] } };
      }
      throw error;
    }

    const fileNames = entries
      .filter((entry) => entry.isFile() && ROOM_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    const rooms: RoomSummary[] = [];
    const corruptNames: string[] = [];

    await mapLimit(fileNames, LIST_CONCURRENCY, async (name) => {
      const code = name.slice(0, ROOM_CODE_LENGTH);
      try {
        const room = await readRoom(code);
        if (room === null) return; // vanished between readdir and read
        if (room.public === false) return; // AC7: public rooms only
        rooms.push({
          code: room.code,
          title: room.title,
          members: room.members.length,
          hasPasscode: room.passcodeHash !== null && room.passcodeHash !== "",
        });
      } catch (error) {
        if (error instanceof RoomCorruptError) corruptNames.push(name);
        else throw error;
      }
    });

    rooms.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    corruptNames.sort();
    return { rooms, corrupt: { count: corruptNames.length, names: corruptNames } };
  }

  function buildRoom(code: string, input: CreateRoomInput): Room {
    return {
      code,
      title: input.title,
      public: input.public ?? true,
      passcodeHash: input.passcodeHash ?? null,
      createdAt: input.createdAt ?? Date.now(),
      members: structuredClone(input.members ?? []),
      votes: structuredClone(input.votes ?? []),
    };
  }

  async function create(input: CreateRoomInput): Promise<Room> {
    if (input.code !== undefined) {
      assertCode(input.code);
      const candidate = buildRoom(input.code, input);
      const issues = validateRoom(candidate);
      if (issues.length > 0) throw new RoomValidationError(issues);
      return withLock(candidate.code, async () => {
        if (await fileExists(roomFile(candidate.code))) {
          throw new RoomExistsError(candidate.code);
        }
        await writeRoomAtomic(candidate);
        return candidate;
      });
    }

    for (let attempt = 0; attempt < CREATE_CODE_ATTEMPTS; attempt++) {
      const candidate = buildRoom(generateRoomCode(), input);
      const issues = validateRoom(candidate);
      if (issues.length > 0) throw new RoomValidationError(issues);
      const created = await withLock(candidate.code, async () => {
        if (await fileExists(roomFile(candidate.code))) return false;
        await writeRoomAtomic(candidate);
        return true;
      });
      if (created) return candidate;
    }
    throw new Error(
      `could not allocate a free room code after ${CREATE_CODE_ATTEMPTS} attempts`,
    );
  }

  async function mutate(code: string, fn: RoomMutator): Promise<Room> {
    assertCode(code);
    return withLock(code, async () => {
      const current = await readRoom(code);
      if (current === null) throw new RoomNotFoundError(code);

      // Work on a clone so a throwing/invalid mutation cannot dirty anything.
      const draft = structuredClone(current);
      const produced = await fn(draft);
      const next = produced === undefined ? draft : produced;

      const issues = validateRoom(next);
      if (issues.length > 0) throw new RoomValidationError(issues);
      if (next.code !== code) {
        throw new RoomValidationError([
          `mutation changed code "${code}" to "${next.code}"; mutate may only write room ${code}`,
        ]);
      }

      await writeRoomAtomic(next);
      return next;
    });
  }

  async function remove(code: string): Promise<boolean> {
    assertCode(code);
    return withLock(code, async () => {
      try {
        await unlink(roomFile(code));
        return true;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    });
  }

  function projectVote(vote: Vote, members: Member[]): HistoryVote {
    const counts: Record<string, number> = {};
    for (const option of vote.options) counts[option] = 0;
    for (const ballot of vote.ballots) {
      counts[ballot.choice] = (counts[ballot.choice] ?? 0) + 1;
    }

    const projected: HistoryVote = {
      id: vote.id,
      title: vote.title,
      options: [...vote.options],
      state: vote.state,
      createdAt: vote.createdAt,
      closedAt: vote.closedAt,
      events: vote.events.map((event) => ({ at: event.at, kind: event.kind, by: event.by })),
      counts,
      votedCount: vote.ballots.length,
    };

    // AC8 / R1-R2: names and per-person choices exist ONLY for closed votes.
    if (vote.state === "closed") {
      const nameBySession = new Map(members.map((member) => [member.session, member.name]));
      projected.result = { ...counts };
      projected.reveal = vote.ballots.map((ballot) => ({
        name: nameBySession.get(ballot.session) ?? ballot.session,
        choice: ballot.choice,
      }));
    }
    return projected;
  }

  async function history(code: string): Promise<HistoryVote[]> {
    if (typeof code !== "string" || !ROOM_CODE_PATTERN.test(code)) {
      throw new RoomNotFoundError(String(code));
    }
    const room = await readRoom(code);
    if (room === null) throw new RoomNotFoundError(code);
    return room.votes.map((vote) => projectVote(vote, room.members));
  }

  return { dir, roomsDir, get, list, create, mutate, remove, history };
}
