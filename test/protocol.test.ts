// test/protocol.test.ts — the WebSocket protocol contract (POKER-001a
// AC4–AC9, AC11): hello/passcode, name claims (sequential + genuinely
// concurrent), the vote state machine, the raw-wire anonymity assertion,
// per-viewer ordering, caps and rate limiting.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectKeys,
  createRoom,
  join,
  joinAs,
  startServer,
  TestClient,
  type TestServer,
} from "./helpers.ts";

const BANNED_WHILE_OPEN = ["name", "reveal", "ballots", "result"] as const;

function assertNoAnonymityKeys(raw: string, label: string): void {
  const keys = collectKeys(JSON.parse(raw));
  for (const banned of BANNED_WHILE_OPEN) {
    assert.equal(keys.has(banned), false, `${label} leaked key "${banned}" on the wire: ${raw}`);
  }
}

test("hello joins the room and reports you/room/state; presence lists the member", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Friday" });
    const client = await TestClient.connect(server.port);
    client.send({ t: "hello", room: room.code, session: "s-a" });
    const hello = await client.ofType("hello_ok");
    assert.equal(hello.json?.you.session, "s-a");
    assert.equal(hello.json?.you.name, ""); // unclaimed
    assert.equal(hello.json?.room.code, room.code);
    assert.equal(hello.json?.room.hasPasscode, false);
    assert.deepEqual(hello.json?.state.votes, []);

    const presence = await client.ofType("presence");
    assert.equal(presence.json?.members.length, 1);
    assert.equal(presence.json?.members[0].session, "s-a");
    assert.equal(presence.json?.members[0].online, true);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("hello on a protected room rejects a wrong or missing passcode (socket not admitted)", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Secret", passcode: "hunter2" });
    const client = await TestClient.connect(server.port);

    client.send({ t: "hello", room: room.code, session: "s-a", passcode: "nope" });
    await client.errorCode("bad_passcode");
    // Not admitted: room operations are refused.
    client.send({ t: "vote_open", title: "x", options: ["a"] });
    await client.errorCode("not_in_room");

    client.send({ t: "hello", room: room.code, session: "s-a" });
    await client.errorCode("bad_passcode");

    client.send({ t: "hello", room: room.code, session: "s-a", passcode: "hunter2" });
    const hello = await client.ofType("hello_ok");
    assert.equal(hello.json?.room.hasPasscode, true);
    assert.equal(hello.json?.room.passcodeHash, undefined);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("hello into an unknown room is refused with bad_room", async () => {
  const server = await startServer();
  try {
    const client = await TestClient.connect(server.port);
    client.send({ t: "hello", room: "ZZZZZZ", session: "s-a" });
    await client.errorCode("bad_room");
    client.send({ t: "hello", room: "not-a-code", session: "s-a" });
    await client.errorCode("bad_room");
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("room_join behaves like hello (including the passcode gate)", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Secret", passcode: "pw" });
    const wrong = await TestClient.connect(server.port);
    wrong.send({ t: "room_join", room: room.code, session: "s-x", passcode: "bad" });
    await wrong.errorCode("bad_passcode");
    wrong.destroy();

    const right = await TestClient.connect(server.port);
    right.send({ t: "room_join", room: room.code, session: "s-x", passcode: "pw" });
    const hello = await right.ofType("hello_ok");
    assert.equal(hello.json?.you.session, "s-x");
    right.destroy();
  } finally {
    await server.stop();
  }
});

test("claim: first claim wins, a collision is rejected, and a colliding rename too", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Names" });
    const alice = await joinAs(server, room.code, "s-a", "Alice");
    const bob = await join(server, room.code, "s-b");

    bob.send({ t: "claim", name: "Alice" });
    await bob.errorCode("name_taken");
    // Case-insensitive: "alice" also collides.
    bob.send({ t: "claim", name: "alice" });
    await bob.errorCode("name_taken");
    bob.send({ t: "claim", name: "Bob" });
    await bob.ofType("claim_ok");

    // Renaming onto an existing name is rejected; renaming to a free one works.
    alice.send({ t: "claim", name: "Bob" });
    await alice.errorCode("name_taken");
    alice.send({ t: "claim", name: "Alicia" });
    await alice.ofType("claim_ok");

    alice.destroy();
    bob.destroy();
  } finally {
    await server.stop();
  }
});

test("claim: N simultaneous claims for one name — exactly one winner (R7 race)", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Race" });
    const clients = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        join(server, room.code, `s-race-${index}`),
      ),
    );
    // Fire all eight in the same tick; the db's per-room write lock decides.
    for (const client of clients) client.send({ t: "claim", name: "Racer" });
    const results = await Promise.all(
      clients.map((client) =>
        client.waitFor(
          (frame) =>
            frame.json?.t === "claim_ok" ||
            (frame.json?.t === "error" && frame.json.code === "name_taken"),
          "claim outcome",
        ),
      ),
    );
    const winners = results.filter((frame) => frame.json?.t === "claim_ok");
    const losers = results.filter(
      (frame) => frame.json?.t === "error" && frame.json.code === "name_taken",
    );
    assert.equal(winners.length, 1, `exactly one claim must win (got ${winners.length})`);
    assert.equal(losers.length, 7);

    // The persisted room has exactly one member named Racer.
    const stored = await server.db.get(room.code);
    assert.equal(stored?.members.filter((member) => member.name === "Racer").length, 1);
    for (const client of clients) client.destroy();
  } finally {
    await server.stop();
  }
});

test("vote_open → vote_cast → vote_close → vote_reopen transitions + events", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Transitions" });
    const alice = await joinAs(server, room.code, "s-a", "Alice");
    const bob = await joinAs(server, room.code, "s-b", "Bob");

    alice.send({ t: "vote_open", title: "Who pays?", options: ["Bob", "Alice", "Split"] });
    const opened = await bob.ofType("vote_new");
    const voteId = opened.json?.vote.id as string;
    assert.equal(opened.json?.vote.state, "open");
    assert.deepEqual(opened.json?.vote.counts, { Bob: 0, Alice: 0, Split: 0 });
    assert.equal(opened.json?.vote.votedCount, 0);
    assert.equal(opened.json?.vote.totalMembers, 2);

    // Both clients hear about the cast, aggregate only.
    bob.send({ t: "vote_cast", voteId, choice: "Bob" });
    const update = await alice.ofType("vote_update");
    assert.equal(update.json?.vote.counts.Bob, 1);
    assert.equal(update.json?.vote.votedCount, 1);

    // vote_change overwrites (last write wins while open).
    bob.send({ t: "vote_change", voteId, choice: "Alice" });
    const changed = await alice.waitFor(
      (frame) => frame.json?.t === "vote_update" && frame.json?.vote.counts.Alice === 1,
      "vote_update after change",
    );
    assert.equal(changed.json?.vote.counts.Bob, 0);
    assert.equal(changed.json?.vote.votedCount, 1);

    // A cast on a closed vote is refused.
    alice.send({ t: "vote_close", voteId });
    const closed = await bob.ofType("vote_closed");
    assert.equal(closed.json?.vote.state, "closed");
    assert.deepEqual(
      closed.json?.vote.reveal,
      [{ name: "Bob", choice: "Alice" }],
    );
    bob.send({ t: "vote_cast", voteId, choice: "Split" });
    await bob.errorCode("vote_closed");

    // Reopen: same vote, names hidden again, casts work.
    alice.send({ t: "vote_reopen", voteId });
    const reopened = await bob.ofType("vote_reopened");
    assert.equal(reopened.json?.vote.state, "open");
    assert.equal(reopened.json?.vote.id, voteId);
    assert.equal(reopened.json?.vote.reveal, undefined);
    alice.send({ t: "vote_cast", voteId, choice: "Split" });
    await bob.waitFor(
      (frame) => frame.json?.t === "vote_update" && frame.json?.vote.counts.Split === 1,
      "vote_update after reopen cast",
    );

    // Events keep opened + closed + reopened, `by` = the acting session.
    const history = (await (await fetch(`${server.base}/api/rooms/${room.code}/history`)).json()) as any;
    assert.equal(history.votes.length, 1);
    assert.deepEqual(
      history.votes[0].events.map((event: any) => event.kind),
      ["opened", "closed", "reopened"],
    );
    assert.deepEqual(
      history.votes[0].events.map((event: any) => event.by),
      ["s-a", "s-a", "s-a"],
    );

    alice.destroy();
    bob.destroy();
  } finally {
    await server.stop();
  }
});

test("anonymity: an OPEN vote never puts name/reveal/ballots on the wire (raw frames)", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Secret ballot" });
    const alice = await joinAs(server, room.code, "s-a", "Alice");
    const bob = await joinAs(server, room.code, "s-b", "Bob");
    const carol = await joinAs(server, room.code, "s-c", "Carol");

    alice.send({ t: "vote_open", title: "Who pays?", options: ["Bob", "Alice", "Split"] });
    const opened = await bob.ofType("vote_new");
    assertNoAnonymityKeys(opened.raw, "vote_new (open)");
    const voteId = opened.json?.vote.id as string;

    // Every other connection sees its own aggregate-only update.
    bob.send({ t: "vote_cast", voteId, choice: "Bob" });
    const bobUpdate = await carol.waitFor(
      (frame) => frame.json?.t === "vote_update",
      "vote_update",
    );
    assertNoAnonymityKeys(bobUpdate.raw, "vote_update (open)");
    assert.equal(bobUpdate.json?.vote.counts.Bob, 1);
    assert.equal(bobUpdate.json?.vote.votedCount, 1);

    carol.send({ t: "vote_cast", voteId, choice: "Split" });
    const carolUpdate = await alice.waitFor(
      (frame) => frame.json?.t === "vote_update" && frame.json?.vote.votedCount === 2,
      "second vote_update",
    );
    assertNoAnonymityKeys(carolUpdate.raw, "vote_update (open, 2 votes)");

    // hello_ok's state for an open vote is safe too. (The frame's own
    // `you.name` is this viewer's identity, not a ballot, so scan the votes.)
    const late = await TestClient.connect(server.port);
    late.send({ t: "hello", room: room.code, session: "s-late" });
    const hello = await late.ofType("hello_ok");
    assertNoAnonymityKeys(JSON.stringify(hello.json?.state.votes), "hello_ok state (open)");

    // HTTP history for the open vote is aggregate-only as well.
    const openHistory = (await (
      await fetch(`${server.base}/api/rooms/${room.code}/history`)
    ).json()) as any;
    assertNoAnonymityKeys(JSON.stringify(openHistory.votes), "history (open)");

    // Closing reveals names to everyone — the intended behaviour.
    alice.send({ t: "vote_close", voteId });
    const closed = await bob.ofType("vote_closed");
    assert.equal(Array.isArray(closed.json?.vote.reveal), true);
    const reveal = closed.json?.vote.reveal as { name: string; choice: string }[];
    assert.deepEqual(
      reveal.map((entry) => [entry.name, entry.choice]).sort(),
      [
        ["Bob", "Bob"],
        ["Carol", "Split"],
      ],
    );

    for (const client of [alice, bob, carol, late]) client.destroy();
  } finally {
    await server.stop();
  }
});

test("ordering: stable per viewer, different across viewers, self always last", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "Order" });
    const sessions = ["s-0", "s-1", "s-2", "s-3", "s-4", "s-5"];
    const clients = await Promise.all(
      sessions.map((session, index) => joinAs(server, room.code, session, `P${index}`)),
    );

    clients[0]!.send({ t: "vote_open", title: "Order test", options: ["a", "b"] });
    const voteId = (await clients[0]!.ofType("vote_new")).json?.vote.id as string;

    const orders: Record<string, string[]> = {};
    for (const [index, client] of clients.entries()) {
      const frame = await client.waitFor(
        (candidate) => candidate.json?.t === "vote_you" && candidate.json?.voteId === voteId,
        "vote_you",
      );
      const order = frame.json?.order as string[];
      assert.equal(order.length, sessions.length, "order covers every member");
      assert.equal(order[order.length - 1], sessions[index], "self is last");
      assert.equal(frame.json?.self, sessions[index]);
      assert.deepEqual([...order].sort(), [...sessions].sort(), "no duplicates, no omissions");
      orders[sessions[index]!] = order;
    }

    // Same viewer, same vote → identical order (re-hello on a new connection).
    const again = await join(server, room.code, "s-0");
    const frame = await again.waitFor(
      (candidate) => candidate.json?.t === "vote_you" && candidate.json?.voteId === voteId,
      "vote_you (re-join)",
    );
    assert.deepEqual(frame.json?.order, orders["s-0"], "order is stable for one viewer");
    again.destroy();

    // Different viewers see different orders.
    assert.notDeepEqual(orders["s-0"], orders["s-1"]);

    for (const client of clients) client.destroy();
  } finally {
    await server.stop();
  }
});

test("caps: options, name length, votes-per-room and members-per-room are clean errors", async () => {
  const server = await startServer();
  try {
    // 200 members already in the room → a new session cannot join.
    const full = await server.db.create({
      title: "Full",
      members: Array.from({ length: 200 }, (_, index) => ({
        session: `s-full-${index}`,
        name: `N${index}`,
        joinedAt: 1,
        lastSeenAt: 1,
      })),
    });
    const overflow = await TestClient.connect(server.port);
    overflow.send({ t: "hello", room: full.code, session: "s-late" });
    await overflow.errorCode("room_full");
    overflow.destroy();

    // 50 votes already created → vote_open is refused.
    const busy = await server.db.create({
      title: "Busy",
      votes: Array.from({ length: 50 }, (_, index) => ({
        id: `v${index + 1}`,
        title: "seed",
        options: ["a"],
        state: "closed" as const,
        createdAt: 1,
        closedAt: 2,
        events: [{ at: 1, kind: "opened" as const, by: "s-seed" }],
        ballots: [],
      })),
    });
    const voter = await join(server, busy.code, "s-voter");
    voter.send({ t: "vote_open", title: "Too many", options: ["a"] });
    await voter.errorCode("too_many_votes");

    const room = await createRoom(server, { title: "Caps" });
    const client = await join(server, room.code, "s-caps");

    client.send({ t: "claim", name: "x".repeat(25) });
    await client.errorCode("name_too_long");
    client.send({ t: "claim", name: "   " });
    await client.errorCode("bad_name");

    client.send({
      t: "vote_open",
      title: "Too many options",
      options: Array.from({ length: 33 }, (_, index) => `option-${index}`),
    });
    await client.errorCode("too_many_options");

    // A valid vote still works right after the rejections.
    client.send({ t: "vote_open", title: "Fine", options: ["yes", "no"] });
    const opened = await client.ofType("vote_new");
    const voteId = opened.json?.vote.id as string;

    client.send({ t: "vote_cast", voteId, choice: "not-an-option" });
    await client.errorCode("bad_choice");
    client.send({ t: "vote_cast", voteId: "v-does-not-exist", choice: "yes" });
    await client.errorCode("bad_vote");

    client.destroy();
    voter.destroy();
  } finally {
    await server.stop();
  }
});

test("rate limiting returns rate_limited without dropping the socket", async () => {
  const server = await startServer({ rateLimit: { messages: 3, windowMs: 10_000 } });
  try {
    const client = await TestClient.connect(server.port);
    for (let i = 0; i < 6; i++) client.send({ t: "ping" });
    await client.errorCode("rate_limited");
    assert.equal(client.closed, false);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("unknown message types and non-object payloads get bad_message", async () => {
  const server = await startServer();
  try {
    const client = await TestClient.connect(server.port);
    client.send({ t: "definitely_not_a_message" });
    await client.errorCode("bad_message");
    client.sendText("[1,2,3]");
    await client.errorCode("bad_message");
    client.sendText('"just a string"');
    await client.errorCode("bad_message");
    client.send({ t: "ping" });
    await client.ofType("pong");
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("room_create + room_list: public rooms only, never a passcode", async () => {
  const server = await startServer();
  try {
    const client = await TestClient.connect(server.port);
    client.send({ t: "room_create", title: "Open room", public: true });
    const created = await client.ofType("room_created");
    const openCode = created.json?.room.code as string;
    assert.match(openCode, /^[A-Z0-9]{6}$/);
    assert.equal(created.json?.room.hasPasscode, false);

    client.send({ t: "room_create", title: "Locked room", public: true, passcode: "pw" });
    const locked = await client.ofType("room_created");
    assert.equal(locked.json?.room.hasPasscode, true);

    client.send({ t: "room_create", title: "Private room", public: false });
    const privateCreated = await client.ofType("room_created");
    const privateCode = privateCreated.json?.room.code as string;

    client.send({ t: "room_list" });
    const list = await client.ofType("rooms");
    const codes = (list.json?.rooms as any[]).map((room) => room.code);
    assert.ok(codes.includes(openCode));
    assert.ok(codes.includes(locked.json.room.code));
    assert.equal(codes.includes(privateCode), false, "private rooms are not listed");
    for (const room of list.json?.rooms as any[]) {
      assert.equal(typeof room.hasPasscode, "boolean");
      assert.equal(typeof room.members, "number");
      assert.equal("passcode" in room, false);
      assert.equal("passcodeHash" in room, false);
    }

    client.destroy();
  } finally {
    await server.stop();
  }
});

export type { TestServer };
