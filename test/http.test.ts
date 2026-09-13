// test/http.test.ts — the HTTP surface (POKER-001a AC2/AC10): health, the room
// routes, history, 404s and static serving with Cache-Control: no-cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, TestClient, createRoom, joinAs } from "./helpers.ts";

test("GET /api/health reports ok/version/rooms/connections/uptime", async () => {
  const server = await startServer({ version: "9.9.9-test" });
  try {
    const response = await fetch(`${server.base}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.version, "9.9.9-test");
    assert.equal(typeof body.rooms, "number");
    assert.equal(typeof body.connections, "number");
    assert.equal(typeof body.uptime, "number");
    assert.equal(body.connections, 0);
    // POKER-008: a non-empty client build stamp for the self-update watchdog.
    assert.equal(typeof body.build, "string");
    assert.ok(body.build.length > 0, "health carries a build stamp");

    await createRoom(server, { title: "Counted" });
    const withRoom = (await (await fetch(`${server.base}/api/health`)).json()) as any;
    assert.equal(withRoom.rooms, 1);

    const client = await TestClient.connect(server.port);
    const withConnection = (await (await fetch(`${server.base}/api/health`)).json()) as any;
    assert.equal(withConnection.connections, 1);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("POST /api/rooms creates a room; GET list/detail/history round-trip", async () => {
  const server = await startServer();
  try {
    const room = await createRoom(server, { title: "HTTP room" });
    assert.match(room.code, /^[A-Z0-9]{6}$/);
    assert.equal(room.hasPasscode, false);
    assert.equal(room.memberCount, 0);

    const list = (await (await fetch(`${server.base}/api/rooms`)).json()) as any;
    assert.equal(list.rooms.length, 1);
    assert.deepEqual(list.rooms[0], {
      code: room.code,
      title: "HTTP room",
      members: 0,
      hasPasscode: false,
    });

    const detail = (await (await fetch(`${server.base}/api/rooms/${room.code}`)).json()) as any;
    assert.equal(detail.room.code, room.code);
    assert.equal("passcodeHash" in detail.room, false);

    const history = (await (
      await fetch(`${server.base}/api/rooms/${room.code}/history`)
    ).json()) as any;
    assert.deepEqual(history.votes, []);

    // Open a vote so history has content, and cast on the fixed deck (POKER-002).
    const alice = await joinAs(server, room.code, "s-a", "Alice");
    alice.send({ t: "vote_open", title: "History vote" });
    const voteId = (await alice.ofType("vote_new")).json?.vote.id as string;
    alice.send({ t: "vote_cast", voteId, choice: "3" });
    await alice.ofType("vote_update");

    const openHistory = (await (
      await fetch(`${server.base}/api/rooms/${room.code}/history`)
    ).json()) as any;
    assert.equal(openHistory.votes.length, 1);
    assert.equal(openHistory.votes[0].state, "open");
    assert.equal(openHistory.votes[0].counts["3"], 1);
    assert.equal(openHistory.votes[0].votedCount, 1);
    assert.equal("reveal" in openHistory.votes[0], false, "open history must not reveal");
    assert.equal("ballots" in openHistory.votes[0], false);

    alice.send({ t: "vote_close", voteId });
    await alice.ofType("vote_closed");
    const closedHistory = (await (
      await fetch(`${server.base}/api/rooms/${room.code}/history`)
    ).json()) as any;
    assert.deepEqual(closedHistory.votes[0].reveal, [{ name: "Alice", choice: "3" }]);
    alice.destroy();
  } finally {
    await server.stop();
  }
});

test("GET /api/rooms lists public rooms only and never a passcode", async () => {
  const server = await startServer();
  try {
    const open = await createRoom(server, { title: "Open" });
    const locked = await createRoom(server, { title: "Locked", passcode: "pw" });
    await createRoom(server, { title: "Private", public: false });

    const body = (await (await fetch(`${server.base}/api/rooms`)).json()) as any;
    const codes = body.rooms.map((room: any) => room.code);
    assert.deepEqual(codes.sort(), [locked.code, open.code].sort());
    const lockedEntry = body.rooms.find((room: any) => room.code === locked.code);
    assert.equal(lockedEntry.hasPasscode, true);
    assert.equal("passcode" in lockedEntry, false);
    assert.equal("passcodeHash" in lockedEntry, false);

    // The detail endpoint exposes hasPasscode but never the hash.
    const detail = (await (await fetch(`${server.base}/api/rooms/${locked.code}`)).json()) as any;
    assert.equal(detail.room.hasPasscode, true);
    assert.equal("passcodeHash" in detail.room, false);
  } finally {
    await server.stop();
  }
});

test("unknown routes and rooms are 404 with JSON, and bad bodies are 400", async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/api/rooms/ZZZZZZ`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/rooms/ZZZZZZ/history`)).status, 404);
    assert.equal((await fetch(`${server.base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${server.base}/definitely-missing.js`)).status, 404);

    const badJson = await fetch(`${server.base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json",
    });
    assert.equal(badJson.status, 400);

    const noTitle = await fetch(`${server.base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    assert.equal(noTitle.status, 400);
  } finally {
    await server.stop();
  }
});

test("static files are served with Cache-Control: no-cache", async () => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "poker-public-"));
  await fs.writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>poker</title>");
  await fs.writeFile(path.join(publicDir, "app.js"), "export const x = 1;\n");
  const server = await startServer({ publicDir });
  try {
    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.match(await index.text(), /<title>poker<\/title>/);

    const js = await fetch(`${server.base}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "no-cache");
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    // Path traversal never escapes the static root.
    const escaped = await fetch(`${server.base}/..%2f..%2fetc%2fpasswd`);
    assert.equal(escaped.status, 404);
  } finally {
    await server.stop();
    await fs.rm(publicDir, { recursive: true, force: true });
  }
});
