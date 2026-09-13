// test/helpers.ts — a raw WebSocket test client + server harness.
//
// Deliberately NOT a library: it hand-builds masked client frames so the tests
// exercise the server's real framing (7/16/64-bit lengths, unmasking, ping/
// pong, close) rather than hiding it behind a client implementation.

import net from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPokerServer, type PokerServer, type PokerServerOptions } from "../server.ts";
import { openDb, type Db, type Room } from "../lib/db.ts";

export interface WireFrame {
  /** The exact text the server put on the wire (text frames only). */
  raw: string;
  json: Record<string, any> | null;
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encode one frame. Client frames are masked by default (RFC 6455). */
export function encodeFrame(
  opcode: number,
  payload: Buffer,
  options: { mask?: boolean; fin?: boolean } = {},
): Buffer {
  const fin = options.fin !== false;
  const masked = options.mask !== false;
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  header[1] |= 0x80;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i & 3]!;
  return Buffer.concat([header, key, body]);
}

/** Decode as many complete frames as `buffer` contains. */
export function decodeFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let key: Buffer | null = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      key = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

interface Waiter {
  predicate: (frame: WireFrame) => boolean;
  resolve: (frame: WireFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class TestClient {
  readonly messages: WireFrame[] = [];
  readonly controlFrames: DecodedFrame[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((error: Error) => void) | null = null;
  private waiters: Waiter[] = [];
  /** Messages before this index have already been returned by a waitFor. */
  private consumed = 0;
  private gone = false;

  // No TS parameter properties: Node's strip-only type stripping rejects them.
  private readonly socket: net.Socket;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.onGone());
    socket.on("close", () => this.onGone());
  }

  static async connect(port: number, requestPath = "/ws"): Promise<TestClient> {
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    const client = new TestClient(socket);
    const key = randomBytes(16).toString("base64");
    socket.write(
      `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await client.awaitHandshake(requestPath);
    return client;
  }

  private awaitHandshake(requestPath: string): Promise<void> {
    if (this.handshakeDone) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      setTimeout(() => {
        if (!this.handshakeDone) reject(new Error(`handshake timeout for ${requestPath}`));
      }, 3000).unref();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString("latin1");
      const status = Number(head.split(" ")[1]);
      this.buffer = this.buffer.subarray(end + 4);
      this.handshakeDone = true;
      if (status !== 101) {
        this.handshakeReject?.(new Error(`upgrade failed with ${status}`));
        return;
      }
      this.handshakeResolve?.();
    }
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: DecodedFrame): void {
    if (frame.opcode === 0x1) {
      const raw = frame.payload.toString("utf8");
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(raw) as Record<string, any>;
      } catch {
        json = null;
      }
      const message: WireFrame = { raw, json };
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        clearTimeout(waiter.timer);
        this.consumed = this.messages.length;
        waiter.resolve(message);
        break;
      }
      return;
    }
    this.controlFrames.push(frame);
    if (frame.opcode === 0x8) this.onGone();
  }

  private onGone(): void {
    if (this.gone) return;
    this.gone = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("socket closed"));
    }
    this.waiters = [];
  }

  get closed(): boolean {
    return this.gone;
  }

  send(value: unknown): void {
    this.sendRaw(Buffer.from(JSON.stringify(value), "utf8"));
  }

  sendText(text: string): void {
    this.sendRaw(Buffer.from(text, "utf8"));
  }

  sendRaw(payload: Buffer): void {
    if (this.socket.destroyed) throw new Error("socket destroyed");
    this.socket.write(encodeFrame(0x1, payload));
  }

  /** Write raw bytes with no framing at all (handshake/framing abuse). */
  write(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  frame(opcode: number, payload: Buffer, options: { mask?: boolean; fin?: boolean } = {}): void {
    this.socket.write(encodeFrame(opcode, payload, options));
  }

  ping(payload = Buffer.alloc(0)): void {
    this.frame(0x9, payload);
  }

  waitFor(
    predicate: (frame: WireFrame) => boolean,
    label = "frame",
    timeoutMs = 5000,
  ): Promise<WireFrame> {
    // Cursor semantics: each frame is handed out at most once, so two
    // sequential `ofType("vote_update")` calls see two different updates.
    for (let index = this.consumed; index < this.messages.length; index++) {
      const candidate = this.messages[index]!;
      if (!predicate(candidate)) continue;
      this.consumed = index + 1;
      return Promise.resolve(candidate);
    }
    return new Promise<WireFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate.timer !== timer);
        reject(
          new Error(
            `timeout waiting for ${label}; saw: ${JSON.stringify(this.messages.map((m) => m.raw))}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  ofType(type: string, timeoutMs = 5000): Promise<WireFrame> {
    return this.waitFor((frame) => frame.json?.t === type, type, timeoutMs);
  }

  errorCode(code: string, timeoutMs = 5000): Promise<WireFrame> {
    return this.waitFor(
      (frame) => frame.json?.t === "error" && frame.json.code === code,
      `error ${code}`,
      timeoutMs,
    );
  }

  /** Assert nothing matching `predicate` arrives within `ms`. */
  async expectNone(predicate: (frame: WireFrame) => boolean, ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const hit = this.messages.slice(this.consumed).find(predicate);
    if (hit) throw new Error(`unexpected frame: ${hit.raw}`);
  }

  /** Wait until the socket is gone (close frame or TCP close). */
  async waitForClose(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.gone) {
      if (Date.now() > deadline) throw new Error("timeout waiting for socket close");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Wait for a control frame (ping/pong/close) with a given opcode. */
  async waitForControl(opcode: number, timeoutMs = 3000): Promise<DecodedFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.controlFrames.find((frame) => frame.opcode === opcode);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timeout waiting for control frame ${opcode}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

export interface TestServer {
  app: PokerServer;
  db: Db;
  port: number;
  base: string;
  dir: string;
  stop(): Promise<void>;
}

/** Boot the real server on port 0 with a fresh temp DATA_DIR. */
export async function startServer(overrides: PokerServerOptions = {}): Promise<TestServer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "poker-test-"));
  const db = overrides.db ?? openDb({ dir });
  const app = createPokerServer({ dataDir: dir, db, ...overrides });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    db,
    port,
    dir,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** POST /api/rooms and return the created room metadata. */
export async function createRoom(
  server: TestServer,
  input: { title: string; public?: boolean; passcode?: string },
): Promise<Record<string, any>> {
  const response = await fetch(`${server.base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`createRoom failed: ${response.status}`);
  const body = (await response.json()) as { room: Record<string, any> };
  return body.room;
}

/** Connect, hello, and wait for hello_ok. */
export async function join(
  server: TestServer,
  code: string,
  session: string,
  passcode?: string,
): Promise<TestClient> {
  const client = await TestClient.connect(server.port);
  client.send({ t: "hello", room: code, session, passcode });
  const frame = await client.ofType("hello_ok");
  if (frame.json?.room?.code !== code) throw new Error("hello_ok for the wrong room");
  return client;
}

/** Connect, hello, claim, and wait for claim_ok. */
export async function joinAs(
  server: TestServer,
  code: string,
  session: string,
  name: string,
  passcode?: string,
): Promise<TestClient> {
  const client = await join(server, code, session, passcode);
  client.send({ t: "claim", name });
  await client.ofType("claim_ok");
  return client;
}

/** Every object key appearing anywhere in a decoded JSON value. */
export function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

export type { Room };
