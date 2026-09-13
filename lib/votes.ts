// lib/votes.ts — the vote state machine's pure rules + the ONE anonymity-safe
// vote serializer (POKER-001a AC6/AC7/AC8/AC11).
//
// Everything a client is ever told about a vote goes through `serializeVote`.
// While a vote is `open` it emits aggregate counts only: no `name`, no
// `reveal`, no `ballots`, no per-person choice. `reveal` is added in exactly
// one place, for closed votes. Do not hand-build vote payloads anywhere else
// (POKER-001 §1.2 R1/R2 — the product's one rule).
//
// Types come from `lib/db.ts` (owned by POKER-001b, parent §1.1) so the schema
// has a single definition.

import type { Member, Room, Vote, VoteState } from "./db.ts";

/** Caps from POKER-001a AC11 — exceeding one is a clean `error`, never a crash. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 24;
export const MAX_MEMBERS = 200;
export const MAX_VOTES = 50;
export const MAX_TITLE_LENGTH = 80;
export const MAX_PASSCODE_LENGTH = 128;

/**
 * The ONE vote deck (POKER-002 AC1). Planning poker's Fibonacci scale.
 * A vote's options are server-owned: `vote_open` carries only a title and any
 * client-supplied `options` is ignored, so a room can never be handed a custom
 * or hostile deck. Frozen — change it only with a new ticket that says so.
 */
export const VOTE_DECK: readonly string[] = Object.freeze([
  "0",
  "0.5",
  "1",
  "2",
  "3",
  "5",
  "8",
  "13",
]);

/** Per-connection message rate limit (AC11 `rate_limited`). */
export const RATE_LIMIT_MESSAGES = 60;
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** Aggregate tally for a vote. Ballots for unknown options are still counted. */
export function countsFor(vote: Vote): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const option of vote.options) counts[option] = 0;
  for (const ballot of vote.ballots) {
    counts[ballot.choice] = (counts[ballot.choice] ?? 0) + 1;
  }
  return counts;
}

/** The closed-vote reveal. Only `serializeVote` may call this. */
function revealFor(room: Room, vote: Vote): { name: string; choice: string }[] {
  const nameBySession = new Map(room.members.map((member) => [member.session, member.name]));
  return vote.ballots.map((ballot) => ({
    // Mirror lib/db.ts history(): an unnamed voter is shown by session id.
    name: nameBySession.get(ballot.session) || ballot.session,
    choice: ballot.choice,
  }));
}

/**
 * THE serializer. Every `vote_new` / `vote_update` / `vote_closed` /
 * `vote_reopened` payload and every entry of a `history` frame is built here.
 *
 * Open  → id/title/options/state/counts/votedCount/totalMembers. No reveal.
 * Closed → the same plus `result` and `reveal` (names).
 */
export function serializeVote(room: Room, vote: Vote): Record<string, unknown> {
  const counts = countsFor(vote);
  const view: Record<string, unknown> = {
    id: vote.id,
    title: vote.title,
    options: [...vote.options],
    state: vote.state,
    createdAt: vote.createdAt,
    closedAt: vote.closedAt,
    counts,
    votedCount: vote.ballots.length,
    totalMembers: room.members.length,
  };
  // R1/R2: names exist on the wire only after the vote is closed.
  if (vote.state === "closed") {
    view.result = { ...counts };
    view.reveal = revealFor(room, vote);
  }
  return view;
}

/** Room metadata safe for any client — never `passcodeHash`. */
export function roomMeta(room: Room): Record<string, unknown> {
  return {
    code: room.code,
    title: room.title,
    public: room.public !== false,
    hasPasscode: typeof room.passcodeHash === "string" && room.passcodeHash !== "",
    memberCount: room.members.length,
    createdAt: room.createdAt,
  };
}

/** The public-room projection: `members` is a count, never a passcode. */
export function publicRoomSummary(room: {
  code: string;
  title: string;
  members?: number | Member[];
  hasPasscode?: boolean;
  passcodeHash?: string | null;
  public?: boolean;
}): { code: string; title: string; members: number; hasPasscode: boolean } {
  return {
    code: room.code,
    title: room.title,
    members: Array.isArray(room.members) ? room.members.length : (room.members ?? 0),
    hasPasscode:
      typeof room.hasPasscode === "boolean"
        ? room.hasPasscode
        : typeof room.passcodeHash === "string" && room.passcodeHash !== "",
  };
}

// ---------------------------------------------------------------------------
// Per-viewer voter order (AC8 / R3 / R4)
// ---------------------------------------------------------------------------

/** FNV-1a over the viewer session + vote id — the per-viewer seed. */
function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic PRNG — same seed, same permutation, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The voter order this viewer should see: a deterministic shuffle of every
 * room member seeded by `viewer + voteId`, with the viewer moved last.
 * Stable (pure function of its inputs) and never persisted (AC8).
 */
export function orderFor(room: Room, voteId: string, viewer: string): string[] {
  const sessions = room.members.map((member) => member.session);
  const random = mulberry32(hashSeed(`${viewer}\u0000${voteId}`));
  for (let i = sessions.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = sessions[i]!;
    sessions[i] = sessions[j]!;
    sessions[j] = tmp;
  }
  const at = sessions.indexOf(viewer);
  if (at >= 0) sessions.splice(at, 1);
  sessions.push(viewer); // self is always last (R4)
  return sessions;
}

// ---------------------------------------------------------------------------
// Pure room mutations — always run inside `db.mutate(code, …)`
// ---------------------------------------------------------------------------

export type MutationResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: string };

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

function nextVoteId(room: Room): string {
  let max = 0;
  for (const vote of room.votes) {
    const match = /^v(\d+)$/.exec(vote.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `v${max + 1}`;
}

/**
 * POKER-002 AC2: a session may act on votes only after it has claimed a name.
 * Read from the room itself (never the connection's cached name) so the check
 * runs inside `db.mutate` and cannot race a concurrent claim.
 */
export function isNamed(room: Room, session: string): boolean {
  const member = room.members.find((candidate) => candidate.session === session);
  return typeof member?.name === "string" && member.name.trim() !== "";
}

/** R7: claim a name; POKER-002 AC3: a claimed name is permanent. */
export function applyClaim(
  room: Room,
  input: { session: string; name: unknown; now: number },
): MutationResult<{ name: string }> {
  if (typeof input.name !== "string") return { ok: false, code: "bad_name" };
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, code: "bad_name" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, code: "name_too_long" };
  const folded = name.toLowerCase();
  const existing = room.members.find((member) => member.session === input.session);

  // POKER-002 AC3: once claimed, the name is locked. Re-claiming the SAME name
  // is an idempotent ok (reconnect / reload re-sends it); anything else is
  // refused. Checked before the collision scan so a locked member never sees
  // the more specific `name_taken` for a name they were never allowed to take.
  if (existing && typeof existing.name === "string" && existing.name.trim() !== "") {
    if (existing.name.trim().toLowerCase() === folded) {
      existing.lastSeenAt = input.now;
      return { ok: true, name: existing.name };
    }
    return { ok: false, code: "name_locked" };
  }

  const collides = room.members.some(
    (member) => member.session !== input.session && member.name.toLowerCase() === folded,
  );
  if (collides) return { ok: false, code: "name_taken" };

  if (existing) {
    existing.name = name;
    existing.lastSeenAt = input.now;
  } else {
    if (room.members.length >= MAX_MEMBERS) return { ok: false, code: "room_full" };
    room.members.push({
      session: input.session,
      name,
      joinedAt: input.now,
      lastSeenAt: input.now,
    });
  }
  return { ok: true, name };
}

export function applyOpenVote(
  room: Room,
  input: { title: unknown; by: string; now: number },
): MutationResult<{ vote: Vote }> {
  // POKER-002 AC2: no name, no vote operations.
  if (!isNamed(room, input.by)) return { ok: false, code: "name_required" };
  if (typeof input.title !== "string") return { ok: false, code: "bad_title" };
  const title = input.title.trim();
  if (title === "" || title.length > MAX_TITLE_LENGTH) return { ok: false, code: "bad_title" };
  if (room.votes.length >= MAX_VOTES) return { ok: false, code: "too_many_votes" };

  const vote: Vote = {
    id: nextVoteId(room),
    title,
    // POKER-002 AC1: the deck is server-owned; `vote_open` cannot choose it.
    options: [...VOTE_DECK],
    state: "open",
    createdAt: input.now,
    closedAt: null,
    events: [{ at: input.now, kind: "opened", by: input.by }],
    ballots: [],
  };
  room.votes.push(vote);
  return { ok: true, vote };
}

export function applyCast(
  room: Room,
  input: { voteId: unknown; choice: unknown; session: string; now: number },
): MutationResult<{ vote: Vote; created: boolean }> {
  if (!isNamed(room, input.session)) return { ok: false, code: "name_required" };
  if (typeof input.voteId !== "string" || typeof input.choice !== "string") {
    return { ok: false, code: "bad_message" };
  }
  const vote = room.votes.find((candidate) => candidate.id === input.voteId);
  if (!vote) return { ok: false, code: "bad_vote" };
  if (vote.state !== "open") return { ok: false, code: "vote_closed" };
  if (!vote.options.includes(input.choice)) return { ok: false, code: "bad_choice" };

  // One ballot per session; last write wins while open (§1.1).
  const existing = vote.ballots.find((ballot) => ballot.session === input.session);
  if (existing) {
    existing.choice = input.choice;
    existing.at = input.now;
    return { ok: true, vote, created: false };
  }
  vote.ballots.push({ session: input.session, choice: input.choice, at: input.now });
  return { ok: true, vote, created: true };
}

export function applyClose(
  room: Room,
  input: { voteId: unknown; by: string; now: number },
): MutationResult<{ vote: Vote }> {
  if (!isNamed(room, input.by)) return { ok: false, code: "name_required" };
  if (typeof input.voteId !== "string") return { ok: false, code: "bad_message" };
  const vote = room.votes.find((candidate) => candidate.id === input.voteId);
  if (!vote) return { ok: false, code: "bad_vote" };
  if (vote.state !== "open") return { ok: false, code: "vote_closed" };
  vote.state = "closed";
  vote.closedAt = input.now;
  vote.events.push({ at: input.now, kind: "closed", by: input.by });
  return { ok: true, vote };
}

export function applyReopen(
  room: Room,
  input: { voteId: unknown; by: string; now: number },
): MutationResult<{ vote: Vote }> {
  if (!isNamed(room, input.by)) return { ok: false, code: "name_required" };
  if (typeof input.voteId !== "string") return { ok: false, code: "bad_message" };
  const vote = room.votes.find((candidate) => candidate.id === input.voteId);
  if (!vote) return { ok: false, code: "bad_vote" };
  if (vote.state !== "closed") return { ok: false, code: "vote_open" };
  vote.state = "open";
  vote.closedAt = null;
  vote.events.push({ at: input.now, kind: "reopened", by: input.by });
  return { ok: true, vote };
}

export type { Member, Room, Vote, VoteState };
