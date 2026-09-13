// lib/rooms.ts — room lifecycle, passcodes, live presence and the realtime hub
// (POKER-001a AC4/AC5/AC6/AC9/AC12).
//
// All persistence goes through the `Db` handle from `lib/db.ts` (POKER-001b);
// this module never touches the filesystem. Every change is exactly one
// `db.mutate(code, …)` call, and the read-check-write for name claims and vote
// transitions happens INSIDE that call, so the per-room write lock makes the
// checks race-safe (R7).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db, Member, Room, Vote } from "./db.ts";
import { RoomNotFoundError } from "./db.ts";
import {
  MAX_MEMBERS,
  MAX_NAME_LENGTH,
  MAX_PASSCODE_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeCode,
  orderFor,
  publicRoomSummary,
  roomMeta,
  serializeVote,
  applyCast,
  applyClaim,
  applyClose,
  applyOpenVote,
  applyReopen,
} from "./votes.ts";

export { normalizeCode };

// ---------------------------------------------------------------------------
// Passcodes — only ever stored as a salted scrypt hash (§1.1 `passcodeHash`)
// ---------------------------------------------------------------------------

const PASSCODE_SCHEME = "scrypt";
const PASSCODE_KEY_BYTES = 32;

export function hashPasscode(passcode: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(passcode, salt, PASSCODE_KEY_BYTES).toString("hex");
  return `${PASSCODE_SCHEME}:${salt}:${hash}`;
}

/** True when the room has no passcode, or the supplied one matches. */
export function verifyPasscode(passcode: unknown, stored: string | null | undefined): boolean {
  if (typeof stored !== "string" || stored === "") return true;
  if (typeof passcode !== "string" || passcode === "") return false;
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== PASSCODE_SCHEME) return false;
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(passcode, parts[1]!, PASSCODE_KEY_BYTES);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

/** A live WebSocket client, as the hub sees it. `send` frames JSON. */
export interface Peer {
  readonly id: number;
  session: string | null;
  name: string;
  room: string | null;
  send(message: unknown): void;
  close(): void;
}

export type HubResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: string };

export const UNNAMED = "";

export class Hub {
  private readonly db: Db;
  private readonly peers = new Map<number, Peer>();
  private readonly byRoom = new Map<string, Set<Peer>>();
  private nextPeerId = 1;

  constructor(db: Db) {
    this.db = db;
  }

  // -- connection bookkeeping ------------------------------------------------

  createPeer(handlers: { send(message: unknown): void; close(): void }): Peer {
    return {
      id: this.nextPeerId++,
      session: null,
      name: UNNAMED,
      room: null,
      send: handlers.send,
      close: handlers.close,
    };
  }

  register(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  /** Detach a peer; returns the room code it was in (for a presence broadcast). */
  unregister(peer: Peer): string | null {
    this.peers.delete(peer.id);
    const code = peer.room;
    peer.room = null;
    if (!code) return null;
    const set = this.byRoom.get(code);
    set?.delete(peer);
    if (set && set.size === 0) this.byRoom.delete(code);
    return code;
  }

  connectionCount(): number {
    return this.peers.size;
  }

  private joinRoom(peer: Peer, code: string): void {
    let set = this.byRoom.get(code);
    if (!set) {
      set = new Set();
      this.byRoom.set(code, set);
    }
    set.add(peer);
  }

  private onlineSessions(code: string): Set<string> {
    const online = new Set<string>();
    for (const peer of this.byRoom.get(code) ?? []) {
      if (peer.session) online.add(peer.session);
    }
    return online;
  }

  private peersInRoom(code: string): Peer[] {
    return [...(this.byRoom.get(code) ?? [])];
  }

  broadcast(code: string, message: unknown): void {
    for (const peer of this.byRoom.get(code) ?? []) peer.send(message);
  }

  /** Per-viewer voter order — one `vote_you` frame per connection (AC8). */
  private sendVoteYou(peer: Peer, room: Room, vote: Vote): void {
    if (!peer.session) return;
    peer.send({
      t: "vote_you",
      voteId: vote.id,
      order: orderFor(room, vote.id, peer.session),
      self: peer.session,
    });
  }

  private async broadcastVoteYou(code: string, voteId: string): Promise<void> {
    const room = await this.db.get(code);
    if (!room) return;
    const vote = room.votes.find((candidate) => candidate.id === voteId);
    if (!vote || vote.state !== "open") return;
    for (const peer of this.peersInRoom(code)) this.sendVoteYou(peer, room, vote);
  }

  /** Presence for everyone in the room: persisted members + who is online. */
  async broadcastPresence(code: string): Promise<void> {
    const room = await this.db.get(code);
    if (!room) return;
    const online = this.onlineSessions(code);
    const members = room.members.map((member: Member) => ({
      session: member.session,
      name: member.name,
      online: online.has(member.session),
    }));
    this.broadcast(code, { t: "presence", members });
  }

  // -- protocol operations ---------------------------------------------------

  /** AC4: join (or re-join) a room; a protected room gates admission. */
  async hello(
    peer: Peer,
    input: { room: unknown; session: unknown; passcode?: unknown },
  ): Promise<HubResult> {
    const code = normalizeCode(input.room);
    if (!code) return { ok: false, code: "bad_room" };
    if (typeof input.session !== "string" || input.session.trim() === "") {
      return { ok: false, code: "bad_session" };
    }
    const session = input.session.trim();
    const room = await this.db.get(code);
    if (!room) return { ok: false, code: "bad_room" };
    // R: a wrong/missing passcode never admits the socket.
    if (!verifyPasscode(input.passcode, room.passcodeHash)) {
      return { ok: false, code: "bad_passcode" };
    }

    if (peer.room && peer.room !== code) {
      const previous = this.unregister(peer);
      if (previous) void this.broadcastPresence(previous).catch(() => {});
    }
    peer.session = session;
    peer.room = code;
    this.joinRoom(peer, code);

    const now = Date.now();
    let outcome: HubResult<{ name: string }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      let member = draft.members.find((candidate) => candidate.session === session);
      if (!member) {
        if (draft.members.length >= MAX_MEMBERS) {
          outcome = { ok: false, code: "room_full" };
          return draft;
        }
        member = { session, name: UNNAMED, joinedAt: now, lastSeenAt: now };
        draft.members.push(member);
      } else {
        member.lastSeenAt = now;
      }
      outcome = { ok: true, name: member.name };
      return draft;
    });

    if (!outcome.ok) {
      const previous = this.unregister(peer);
      if (previous) void this.broadcastPresence(previous).catch(() => {});
      return outcome;
    }

    peer.name = outcome.name;
    const current = await this.db.get(code);
    if (!current) return { ok: false, code: "bad_room" };
    peer.send({
      t: "hello_ok",
      you: { session, name: peer.name },
      room: roomMeta(current),
      state: { votes: current.votes.map((vote) => serializeVote(current, vote)) },
    });
    await this.broadcastPresence(code);
    for (const vote of current.votes) {
      if (vote.state === "open") this.sendVoteYou(peer, current, vote);
    }
    return { ok: true };
  }

  /** AC5/R7: first claim wins; a colliding rename is rejected too. */
  async claim(peer: Peer, name: unknown): Promise<HubResult<{ name: string }>> {
    const code = peer.room;
    if (!code || !peer.session) return { ok: false, code: "not_in_room" };
    const session = peer.session;
    const now = Date.now();

    let outcome: HubResult<{ name: string }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      outcome = applyClaim(draft, { session, name, now });
      if (outcome.ok) {
        const member = draft.members.find((candidate) => candidate.session === session);
        if (member) peer.name = member.name;
      }
      return draft;
    });

    if (outcome.ok) {
      peer.send({ t: "claim_ok", you: { session, name: outcome.name } });
      await this.broadcastPresence(code);
    }
    return outcome;
  }

  /** AC6: open a vote (any named member); the deck is server-owned (POKER-002). */
  async openVote(
    peer: Peer,
    input: { title: unknown },
  ): Promise<HubResult<{ voteId: string }>> {
    const code = peer.room;
    if (!code || !peer.session) return { ok: false, code: "not_in_room" };
    const session = peer.session;
    const now = Date.now();

    let outcome: HubResult<{ vote: Vote }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      outcome = applyOpenVote(draft, {
        title: input.title,
        by: session,
        now,
      });
      return draft;
    });
    if (!outcome.ok) return outcome;

    const room = await this.db.get(code);
    if (!room) return { ok: false, code: "bad_room" };
    const vote = room.votes.find((candidate) => candidate.id === outcome.vote.id) ?? outcome.vote;
    this.broadcast(code, { t: "vote_new", vote: serializeVote(room, vote) });
    await this.broadcastVoteYou(code, vote.id);
    return { ok: true, voteId: vote.id };
  }

  /** AC6: cast or change a ballot — only while the vote is open. */
  async castVote(
    peer: Peer,
    input: { voteId: unknown; choice: unknown },
  ): Promise<HubResult<{ voteId: string }>> {
    const code = peer.room;
    if (!code || !peer.session) return { ok: false, code: "not_in_room" };
    const session = peer.session;
    const now = Date.now();

    let outcome: HubResult<{ vote: Vote }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      outcome = applyCast(draft, {
        voteId: input.voteId,
        choice: input.choice,
        session,
        now,
      });
      return draft;
    });
    if (!outcome.ok) return outcome;

    const room = await this.db.get(code);
    if (!room) return { ok: false, code: "bad_room" };
    const vote = room.votes.find((candidate) => candidate.id === outcome.vote.id) ?? outcome.vote;
    this.broadcast(code, { t: "vote_update", vote: serializeVote(room, vote) });
    return { ok: true, voteId: vote.id };
  }

  /** AC6/R5: close reveals names to everyone. */
  async closeVote(peer: Peer, voteId: unknown): Promise<HubResult<{ voteId: string }>> {
    const code = peer.room;
    if (!code || !peer.session) return { ok: false, code: "not_in_room" };
    const session = peer.session;
    const now = Date.now();

    let outcome: HubResult<{ vote: Vote }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      outcome = applyClose(draft, { voteId, by: session, now });
      return draft;
    });
    if (!outcome.ok) return outcome;

    const room = await this.db.get(code);
    if (!room) return { ok: false, code: "bad_room" };
    const vote = room.votes.find((candidate) => candidate.id === outcome.vote.id) ?? outcome.vote;
    this.broadcast(code, { t: "vote_closed", vote: serializeVote(room, vote) });
    return { ok: true, voteId: vote.id };
  }

  /** AC6/R6: reopen re-hides names and resumes the same vote. */
  async reopenVote(peer: Peer, voteId: unknown): Promise<HubResult<{ voteId: string }>> {
    const code = peer.room;
    if (!code || !peer.session) return { ok: false, code: "not_in_room" };
    const session = peer.session;
    const now = Date.now();

    let outcome: HubResult<{ vote: Vote }> = { ok: false, code: "bad_message" };
    await this.db.mutate(code, (draft) => {
      outcome = applyReopen(draft, { voteId, by: session, now });
      return draft;
    });
    if (!outcome.ok) return outcome;

    const room = await this.db.get(code);
    if (!room) return { ok: false, code: "bad_room" };
    const vote = room.votes.find((candidate) => candidate.id === outcome.vote.id) ?? outcome.vote;
    this.broadcast(code, { t: "vote_reopened", vote: serializeVote(room, vote) });
    await this.broadcastVoteYou(code, vote.id);
    return { ok: true, voteId: vote.id };
  }

  /** AC9: create a room; the db generates the code. */
  async createRoom(input: {
    title: unknown;
    public?: unknown;
    passcode?: unknown;
  }): Promise<HubResult<{ room: Room }>> {
    if (typeof input.title !== "string") return { ok: false, code: "bad_title" };
    const title = input.title.trim();
    if (title === "" || title.length > MAX_TITLE_LENGTH) return { ok: false, code: "bad_title" };

    let passcodeHash: string | null = null;
    if (input.passcode !== undefined && input.passcode !== null && input.passcode !== "") {
      if (typeof input.passcode !== "string") return { ok: false, code: "bad_passcode" };
      if (input.passcode.length > MAX_PASSCODE_LENGTH) return { ok: false, code: "bad_passcode" };
      passcodeHash = hashPasscode(input.passcode);
    }

    const room = await this.db.create({
      title,
      public: input.public !== false,
      passcodeHash,
    });
    return { ok: true, room };
  }

  /** AC9: public rooms only, projected, never a passcode. */
  async listPublicRooms(): Promise<ReturnType<typeof publicRoomSummary>[]> {
    const listing = await this.db.list();
    return (listing.rooms ?? []).map((room) => publicRoomSummary(room));
  }

  async roomCount(): Promise<{ rooms: number; corrupt: number }> {
    const listing = await this.db.list();
    return { rooms: listing.rooms.length, corrupt: listing.corrupt?.count ?? 0 };
  }

  /** AC10: room metadata — never the passcode hash. */
  async roomInfo(code: unknown): Promise<Record<string, unknown> | null> {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const room = await this.db.get(normalized);
    if (!room) return null;
    return roomMeta(room);
  }

  /** AC10: history via the db's anonymity-safe projection (AC8 of 001b). */
  async history(code: unknown): Promise<unknown[] | null> {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    try {
      return await this.db.history(normalized);
    } catch (error) {
      if (error instanceof RoomNotFoundError) return null;
      throw error;
    }
  }
}
