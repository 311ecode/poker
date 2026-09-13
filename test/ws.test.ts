// test/ws.test.ts — transport-level tests for the hand-rolled RFC 6455 stack
// (POKER-001a AC3): handshake, 7/16/64-bit lengths, masking, ping/pong, close,
// oversize + malformed frames, and unknown upgrade paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { encodeFrame, decodeFrames, TestClient, startServer } from "./helpers.ts";
import { websocketAccept, unmask } from "../lib/ws.ts";

test("Sec-WebSocket-Accept matches the RFC 6455 example", () => {
  // RFC 6455 §1.3.
  assert.equal(websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("frame lengths: 7-bit, 16-bit and 64-bit round-trip, masked and unmasked", () => {
  for (const size of [0, 5, 125, 126, 300, 65_535, 65_536, 70_000]) {
    const payload = Buffer.alloc(size, 0x41);
    for (const mask of [true, false]) {
      const encoded = encodeFrame(0x1, payload, { mask });
      const { frames, rest } = decodeFrames(encoded);
      assert.equal(rest.length, 0, `no leftover bytes for size ${size}`);
      assert.equal(frames.length, 1, `one frame for size ${size}`);
      assert.equal(frames[0]!.opcode, 0x1);
      assert.equal(frames[0]!.payload.length, size);
      assert.ok(frames[0]!.payload.equals(payload), `payload round-trips for size ${size}`);
    }
  }
});

test("fragmented frames decode in order and the mask is applied", () => {
  const first = encodeFrame(0x1, Buffer.from("he"), { fin: false });
  const second = encodeFrame(0x0, Buffer.from("llo"), { fin: true });
  const { frames } = decodeFrames(Buffer.concat([first, second]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.fin, false);
  assert.equal(frames[1]!.fin, true);
  assert.equal(Buffer.concat([frames[0]!.payload, frames[1]!.payload]).toString(), "hello");
});

test("unmask XORs back to the original bytes", () => {
  const original = Buffer.from("the quick brown fox");
  const masked = Buffer.from(original);
  unmask(masked, Buffer.from([1, 2, 3, 4]));
  assert.notDeepEqual(masked, original);
  unmask(masked, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(masked, original);
});

test("JSON ping gets a JSON pong and the 16-bit length path works", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    client.send({ t: "ping", pad: "x".repeat(200) }); // > 125 bytes → 16-bit header
    const pong = await client.ofType("pong");
    assert.equal(pong.json?.t, "pong");
    client.send({ t: "ping" });
    await client.ofType("pong");
  } finally {
    client.destroy();
    await server.stop();
  }
});

test("frame-level ping gets a pong frame", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    client.ping(Buffer.from("hi"));
    const pong = await client.waitForControl(0xa);
    assert.equal(pong.payload.toString(), "hi");
  } finally {
    client.destroy();
    await server.stop();
  }
});

test("a client close frame is echoed and the socket ends", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    client.frame(0x8, payload);
    await client.waitForClose();
    assert.ok(client.closed);
  } finally {
    client.destroy();
    await server.stop();
  }
});

test("bad JSON → bad_message, socket stays alive and answers ping", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    client.sendText("{not json at all");
    const error = await client.errorCode("bad_message");
    assert.equal(error.json?.code, "bad_message");
    assert.equal(client.closed, false);
    client.send({ t: "ping" });
    await client.ofType("pong");
  } finally {
    client.destroy();
    await server.stop();
  }
});

test("oversize (64-bit length) message → bad_message, socket and process survive", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    // 70 000 bytes needs the 64-bit length form; the server discards it.
    client.sendRaw(Buffer.from(`{"t":"ping","pad":"${"y".repeat(70_000)}"}`, "utf8"));
    await client.errorCode("bad_message");
    assert.equal(client.closed, false);
    client.send({ t: "ping" });
    await client.ofType("pong");

    // The process is still healthy: a brand-new connection works too.
    const second = await TestClient.connect(server.port);
    second.send({ t: "ping" });
    await second.ofType("pong");
    second.destroy();
  } finally {
    client.destroy();
    await server.stop();
  }
});

test("malformed framing (reserved bits) reports bad_message, closes that socket, not the server", async () => {
  const server = await startServer();
  const client = await TestClient.connect(server.port);
  try {
    // RSV1 set, masked, zero-length payload — an RFC 6455 protocol error.
    client.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await client.errorCode("bad_message");
    await client.waitForClose();
  } finally {
    client.destroy();
  }
  try {
    const fresh = await TestClient.connect(server.port);
    fresh.send({ t: "ping" });
    await fresh.ofType("pong");
    fresh.destroy();
  } finally {
    await server.stop();
  }
});

test("unknown upgrade paths are rejected with 404", async () => {
  const server = await startServer();
  try {
    const response = await rawUpgrade(server.port, "/nope");
    assert.match(response, /^HTTP\/1\.1 404 /);
  } finally {
    await server.stop();
  }
});

test("an upgrade without Sec-WebSocket-Key is rejected with 400", async () => {
  const server = await startServer();
  try {
    const socket = net.connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk as Buffer);
    const response = Buffer.concat(chunks).toString("latin1");
    assert.match(response, /^HTTP\/1\.1 400 /);
  } finally {
    await server.stop();
  }
});

async function rawUpgrade(port: number, requestPath: string): Promise<string> {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${requestPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("latin1");
}
