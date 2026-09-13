#!/usr/bin/env node
// scripts/smoke.mjs — POKER-001d AC9 deploy proof.
//
// Runs against a deployed origin (default https://poker.imre.dev) and proves
// the whole public path works end to end:
//   1. GET  /api/health              → {ok:true,…}
//   2. POST /api/rooms               → a room code, over the public origin
//   3. two raw-WebSocket sockets     → hello → hello_ok
//   4. claim + vote_open             → vote_new
//   5. vote_cast on both             → vote_update (the tunnel Upgrade works)
//   6. vote_close                    → vote_closed with both names revealed
//
// It speaks RFC 6455 by hand (no `ws` dependency, mirroring the server's own
// hand-rolled framing), so it also cross-checks the server's frame codec.
//
//   node scripts/smoke.mjs [--origin https://poker.imre.dev] [--ws-url URL]
//                          [--ws-path /ws] [--timeout 15000] [--insecure] [-v]
//
// A room is always created with `public:false` so smoke runs never show up in
// the public room list.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://poker.imre.dev";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---------------------------------------------------------------------------
// RFC 6455 framing (client side: masked frames; server side: unmasked)
// ---------------------------------------------------------------------------

export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const out = Buffer.alloc(header.length + len);
  header.copy(out, 0);
  for (let i = 0; i < len; i++) out[header.length + i] = data[i] ^ mask[i & 3];
  return out;
}

// Incremental decoder. `push()` returns the complete messages in the chunk:
// `{opcode, payload}` (payload already unmasked). Fragmented messages are
// reassembled and delivered on their final continuation frame.
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragOpcode = null;
    this.fragParts = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const r = this._next(); // undefined = need more bytes, null = fragment consumed
      if (r === undefined) break;
      if (r !== null) out.push(r);
    }
    return out;
  }

  _next() {
    const b = this.buf;
    if (b.length < 2) return undefined;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large");
      len = Number(big);
      offset = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return undefined;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return undefined;
    const payload = Buffer.from(b.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(offset + len);

    if (opcode === 0x0) {
      // continuation of a fragmented message
      this.fragParts.push(payload);
      if (!fin) return null;
      const full = Buffer.concat(this.fragParts);
      const op = this.fragOpcode ?? 0x1;
      this.fragParts = [];
      this.fragOpcode = null;
      return { opcode: op, payload: full };
    }
    if ((opcode === 0x1 || opcode === 0x2) && !fin) {
      this.fragOpcode = opcode;
      this.fragParts = [payload];
      return null;
    }
    return { opcode, payload };
  }
}

// Minimal raw WebSocket connection: `send(obj)`, `waitFor(pred, label)`,
// `close()`. Control frames (ping/pong/close) are handled internally.
export class RawSocket {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.onMessage = null; // optional debug hook, set by --verbose
    socket.setNoDelay?.(true);
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => this._onClose());
    socket.on("error", (e) => this._onClose(e));
    if (head && head.length > 0) this._onData(head);
  }

  _onData(chunk) {
    let messages;
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this._failAll(e);
      return;
    }
    for (const m of messages) {
      if (m.opcode === 0x8) {
        try {
          this.socket.end(encodeFrame(m.payload, 0x8));
        } catch {
          /* already gone */
        }
        this._onClose();
        return;
      }
      if (m.opcode === 0x9) {
        try {
          this.socket.write(encodeFrame(m.payload, 0xa));
        } catch {
          /* ignore */
        }
        continue;
      }
      if (m.opcode === 0xa) continue;
      let msg;
      if (m.opcode === 0x1) {
        const text = m.payload.toString("utf8");
        try {
          msg = JSON.parse(text);
        } catch {
          msg = { t: "(unparseable)", raw: text };
        }
      } else {
        msg = { t: "(binary)", raw: m.payload.toString("base64") };
      }
      this.onMessage?.(msg);
      this.queue.push(msg);
      this._flushWaiters();
    }
  }

  _onClose(err) {
    if (this.closed && !err) return;
    this.closed = true;
    this._failAll(err ?? new Error("socket closed"));
  }

  _failAll(err) {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _flushWaiters() {
    for (const w of [...this.waiters]) {
      const idx = this.queue.findIndex(w.pred);
      if (idx !== -1) {
        const [msg] = this.queue.splice(idx, 1);
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(msg);
      }
    }
  }

  send(obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    this.socket.write(encodeFrame(text, 0x1));
  }

  waitFor(pred, label, timeoutMs = 15000) {
    const idx = this.queue.findIndex(pred);
    if (idx !== -1) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg);
    }
    if (this.closed) {
      return Promise.reject(new Error(`socket closed while waiting for ${label}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { pred, label, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        const seen = JSON.stringify(this.queue.slice(-6));
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${label}; recent frames: ${seen}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  // Any unconsumed `error` frame → throw (used between protocol steps).
  assertNoError(step) {
    const err = this.queue.find((m) => m && m.t === "error");
    if (err) throw new Error(`server error during ${step}: ${JSON.stringify(err)}`);
  }

  close() {
    if (this.closed) return;
    try {
      // Flush a close frame, then FIN. main() exits the process explicitly.
      this.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
    } catch {
      this.socket.destroy();
    }
  }
}

export function connectRaw(url, { timeoutMs = 15000, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") {
      reject(new Error(`not a ws/wss URL: ${url}`));
      return;
    }
    const isTls = u.protocol === "wss:";
    const mod = isTls ? https : http;
    const key = crypto.randomBytes(16).toString("base64");
    const expected = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      rejectUnauthorized: !insecure,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        Origin: `${isTls ? "https" : "http"}://${u.host}`,
      },
    });
    req.on("upgrade", (res, socket, head) => {
      if ((res.headers.upgrade ?? "").toLowerCase() !== "websocket") {
        socket.destroy();
        reject(new Error(`server did not switch protocols (Upgrade: ${res.headers.upgrade ?? "missing"})`));
        return;
      }
      const accept = res.headers["sec-websocket-accept"];
      if (accept && accept !== expected) {
        socket.destroy();
        reject(new Error(`bad Sec-WebSocket-Accept (${accept})`));
        return;
      }
      resolve(new RawSocket(socket, head));
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`WebSocket upgrade refused: HTTP ${res.statusCode}`));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`WebSocket upgrade timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers + CLI
// ---------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${url} → not JSON: ${text.slice(0, 300)}`);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractRoomCode(payload) {
  const candidates = [
    payload?.code,
    payload?.room?.code,
    payload?.result?.code,
    payload?.data?.code,
  ];
  return candidates.find((c) => typeof c === "string" && c.length > 0) ?? null;
}

function parseCli(argv) {
  const opts = {
    origin: process.env.SMOKE_ORIGIN ?? DEFAULT_ORIGIN,
    wsUrl: process.env.SMOKE_WS_URL ?? null,
    // The server owns the upgrade at /ws; every other upgrade path is a 404
    // (server.ts). This default must match POKER-001 §1.8.
    wsPath: process.env.SMOKE_WS_PATH ?? "/ws",
    timeout: 15000,
    insecure: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--origin") opts.origin = argv[++i];
    else if (a === "--ws-url") opts.wsUrl = argv[++i];
    else if (a === "--ws-path") opts.wsPath = argv[++i];
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else if (a === "--insecure") opts.insecure = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`poker deploy smoke (AC9) — hello → vote flow over the public origin

  node scripts/smoke.mjs [flags]

Flags:
  --origin <url>    public origin (default ${DEFAULT_ORIGIN}; env SMOKE_ORIGIN)
  --ws-url <url>    full WS URL override; {code} expands to the room code
  --ws-path <path>  WS path when --ws-url is absent (default /; env SMOKE_WS_PATH)
  --timeout <ms>    per-step timeout (default 15000)
  --insecure        accept self-signed TLS (local only)
  -v, --verbose     log every received frame

Exit code 0 = the full flow worked through the public origin.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  const origin = opts.origin.replace(/\/+$/, "");
  const T = opts.timeout;

  console.log(`[smoke] origin: ${origin}`);
  const health = await getJson(`${origin}/api/health`);
  if (health?.ok !== true) {
    throw new Error(`/api/health did not report {ok:true}: ${JSON.stringify(health)}`);
  }
  console.log(`[smoke] /api/health ok: ${JSON.stringify(health)}`);

  const created = await postJson(`${origin}/api/rooms`, {
    title: `smoke-${new Date().toISOString()}`,
    public: false,
  });
  const code = extractRoomCode(created);
  if (!code) throw new Error(`could not read a room code from POST /api/rooms: ${JSON.stringify(created)}`);
  console.log(`[smoke] room created over public origin: ${code}`);

  const wsUrl = (opts.wsUrl ?? `${origin.replace(/^http/, "ws")}${opts.wsPath}`).replace("{code}", code);
  console.log(`[smoke] websocket: ${wsUrl}`);

  const session1 = `s-${crypto.randomUUID()}`;
  const session2 = `s-${crypto.randomUUID()}`;
  const sock1 = await connectRaw(wsUrl, { timeoutMs: T, insecure: opts.insecure });
  const sock2 = await connectRaw(wsUrl, { timeoutMs: T, insecure: opts.insecure });
  if (opts.verbose) {
    sock1.onMessage = (m) => console.log(`[smoke] s1 <- ${JSON.stringify(m)}`);
    sock2.onMessage = (m) => console.log(`[smoke] s2 <- ${JSON.stringify(m)}`);
  }
  console.log("[smoke] two raw WebSocket upgrades accepted (Upgrade: websocket)");

  sock1.send({ t: "hello", room: code, session: session1 });
  sock2.send({ t: "hello", room: code, session: session2 });
  await sock1.waitFor((m) => m.t === "hello_ok", "hello_ok (socket 1)", T);
  await sock2.waitFor((m) => m.t === "hello_ok", "hello_ok (socket 2)", T);
  sock1.assertNoError("hello");
  sock2.assertNoError("hello");
  console.log("[smoke] hello → hello_ok on both sockets");

  sock1.send({ t: "claim", name: "Alice" });
  sock2.send({ t: "claim", name: "Bob" });
  await new Promise((r) => setTimeout(r, 300));
  sock1.assertNoError("claim (Alice)");
  sock2.assertNoError("claim (Bob)");
  console.log("[smoke] claimed Alice + Bob, no name_taken");

  sock1.send({ t: "vote_open", title: "smoke", options: ["Split", "Take"] });
  const voteNew = await sock1.waitFor((m) => m.t === "vote_new", "vote_new (socket 1)", T);
  await sock2.waitFor((m) => m.t === "vote_new", "vote_new (socket 2)", T);
  const voteId = voteNew.vote?.id;
  if (!voteId) throw new Error(`vote_new had no vote.id: ${JSON.stringify(voteNew)}`);
  console.log(`[smoke] vote_open → vote_new (${voteId}) on both sockets`);

  sock1.send({ t: "vote_cast", voteId, choice: "Split" });
  sock2.send({ t: "vote_cast", voteId, choice: "Take" });
  const update = await sock1.waitFor((m) => m.t === "vote_update", "vote_update (socket 1)", T);
  await sock2.waitFor((m) => m.t === "vote_update", "vote_update (socket 2)", T);
  // The one rule that must never break: an OPEN update carries counts only.
  const leaked = JSON.stringify(update).match(/"(name|reveal|ballots)"\s*:/);
  if (leaked) {
    throw new Error(`ANONYMITY LEAK in open vote_update: ${JSON.stringify(update)}`);
  }
  console.log(`[smoke] vote_cast on both → vote_update (open, counts only): ${JSON.stringify(update.vote ?? update)}`);

  sock1.send({ t: "vote_close", voteId });
  const closed = await sock1.waitFor((m) => m.t === "vote_closed", "vote_closed (socket 1)", T);
  const reveal = closed.vote?.reveal;
  if (!Array.isArray(reveal) || reveal.length < 2) {
    throw new Error(`vote_closed did not reveal both voters: ${JSON.stringify(closed)}`);
  }
  const names = reveal.map((r) => r?.name).filter(Boolean);
  if (!names.includes("Alice") || !names.includes("Bob")) {
    throw new Error(`reveal missing Alice/Bob: ${JSON.stringify(reveal)}`);
  }
  console.log(`[smoke] vote_close → vote_closed reveal: ${JSON.stringify(reveal)}`);

  sock1.close();
  sock2.close();
  console.log("[smoke] SMOKE PASS — public origin, HTTP room create, 2× raw WS hello → vote → close");
  // The half-closed raw sockets would otherwise keep the event loop alive; this
  // is a CLI smoke, so exit explicitly with a clear status.
  process.exit(0);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`[smoke] FAIL: ${e.message}`);
    process.exit(1);
  });
}
