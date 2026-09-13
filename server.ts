// server.ts — the poker spine (POKER-001a).
//
// ONE `http.Server` on ONE port serves `public/` and the `/api/*` surface AND
// owns the WebSocket upgrade at `/ws` (AC2/AC3, parent §1.8). Transport is the
// hand-rolled RFC 6455 framing in `lib/ws.ts`; room state lives behind
// `lib/db.ts` (POKER-001b) and is never touched through `fs` from here (AC12).
//
// Run: node server.ts   (Node ≥ 26.8.1 type-stripping, no build step)

import http from "node:http";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Socket } from "node:net";
import { defaultDataDir, openDb, RoomCorruptError, type Db } from "./lib/db.ts";
import { Hub, type Peer } from "./lib/rooms.ts";
import {
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  publicRoomSummary,
  roomMeta,
} from "./lib/votes.ts";
import { WebSocketConnection, websocketAccept } from "./lib/ws.ts";

/** Kept in sync with package.json. */
export const VERSION = "1.0.0";

/** The tunnel origin on g2; `PORT=fixed` binds it, `PORT` unset is ephemeral. */
export const DEFAULT_PORT = 64100;

/** The only WebSocket path. Any other upgrade path is 404 (AC3). */
export const WS_PATH = "/ws";

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0; // random free port
  const value = raw.trim();
  if (value === "fixed") return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `Invalid PORT "${raw}" — use a port number, "fixed", or leave unset for a random port`,
    );
  }
  return n;
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export interface PokerServerOptions {
  /** Base data dir for `lib/db.ts`; `rooms/` is created inside it. */
  dataDir?: string;
  /** Injectable db (tests); defaults to the real `openDb({ dir })`. */
  db?: Db;
  /** Static root; defaults to `<repo>/public`. */
  publicDir?: string;
  version?: string;
  maxMessageBytes?: number;
  /** Per-connection message rate limit; `false` disables it. */
  rateLimit?: { messages: number; windowMs: number } | false;
}

export interface PokerServer {
  server: http.Server;
  hub: Hub;
  db: Db;
  dataDir: string;
  publicDir: string;
  startedAt: number;
  close(): Promise<void>;
}

export function createPokerServer(options: PokerServerOptions = {}): PokerServer {
  const dataDir = options.dataDir ?? defaultDataDir();
  const db = options.db ?? openDb({ dir: dataDir });
  const hub = new Hub(db);
  const publicDir = path.resolve(options.publicDir ?? path.join(import.meta.dirname, "public"));
  const version = options.version ?? VERSION;
  const startedAt = Date.now();
  const maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const rateLimit =
    options.rateLimit === false
      ? null
      : (options.rateLimit ?? { messages: RATE_LIMIT_MESSAGES, windowMs: RATE_LIMIT_WINDOW_MS });

  const sockets = new Set<WebSocketConnection>();
  const buckets = new Map<number, { start: number; count: number }>();

  // -- HTTP -----------------------------------------------------------------

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/api/health") {
      const stats = await hub.roomCount();
      sendJson(res, 200, {
        ok: true,
        version,
        rooms: stats.rooms,
        connections: hub.connectionCount(),
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        // Extra: corrupt room files are reported, never hidden (001b AC5).
        corrupt: stats.corrupt,
        // POKER-008: the client-side build stamp — the newest mtime among the
        // served assets, so an open tab can notice a redeploy and reload itself.
        build: await assetBuild(publicDir),
      });
      return;
    }

    if (pathname === "/api/rooms") {
      if (method === "GET") {
        sendJson(res, 200, { rooms: await hub.listPublicRooms() });
        return;
      }
      if (method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await readJsonBody(req)) as Record<string, unknown>;
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid body" });
          return;
        }
        const result = await hub.createRoom({
          title: body.title,
          public: body.public,
          passcode: body.passcode,
        });
        if (!result.ok) {
          sendJson(res, 400, { error: result.code });
          return;
        }
        sendJson(res, 200, { room: roomMeta(result.room) });
        return;
      }
    }

    const historyMatch = /^\/api\/rooms\/([^/]+)\/history$/.exec(pathname);
    if (method === "GET" && historyMatch) {
      const votes = await hub.history(decodeURIComponent(historyMatch[1]!));
      if (votes === null) {
        sendJson(res, 404, { error: "No such room" });
        return;
      }
      sendJson(res, 200, { votes });
      return;
    }

    const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
    if (method === "GET" && roomMatch) {
      const room = await hub.roomInfo(decodeURIComponent(roomMatch[1]!));
      if (room === null) {
        sendJson(res, 404, { error: "No such room" });
        return;
      }
      sendJson(res, 200, { room });
      return;
    }

    if (method === "GET" || method === "HEAD") {
      await serveStatic(res, pathname, method === "HEAD");
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  async function serveStatic(
    res: http.ServerResponse,
    pathname: string,
    headOnly: boolean,
  ): Promise<void> {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const abs = path.resolve(publicDir, rel);
    if (abs !== publicDir && !abs.startsWith(publicDir + path.sep)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const mime = STATIC_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        // The client is plain ES modules served from here — a stale copy must
        // never be handed out (AC2).
        "Cache-Control": "no-cache",
      });
      if (headOnly) {
        res.end();
        return;
      }
      createReadStream(abs).pipe(res);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  }

  // -- WebSocket upgrade ----------------------------------------------------

  function handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const versionHeader = req.headers["sec-websocket-version"];
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
    if (
      upgrade !== "websocket" ||
      typeof key !== "string" ||
      key.trim() === "" ||
      (versionHeader !== undefined && versionHeader !== "13")
    ) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    attach(socket, head);
  }

  function attach(socket: Socket, head: Buffer): void {
    let peer: Peer;
    const connection = new WebSocketConnection(
      socket,
      {
        onText: (text) => {
          void dispatch(peer, text);
        },
        onTooLarge: () => {
          peer.send({ t: "error", code: "bad_message", detail: "message exceeds 64 KiB" });
        },
        onProtocolError: (detail) => {
          // AC3: report the malformed frame as `bad_message` before lib/ws.ts
          // closes this socket with 1002. The process and other sockets live on.
          peer.send({ t: "error", code: "bad_message", detail });
        },
        onClosed: () => {
          sockets.delete(connection);
          buckets.delete(peer.id);
          const code = hub.unregister(peer);
          if (code) void hub.broadcastPresence(code).catch(() => {});
        },
      },
      { maxMessageBytes },
    );
    sockets.add(connection);
    peer = hub.createPeer({
      send: (message) => connection.sendJson(message),
      close: () => connection.destroy(),
    });
    hub.register(peer);
    if (head.length > 0) connection.push(head);
  }

  // -- protocol dispatch ----------------------------------------------------

  function allow(peer: Peer): boolean {
    if (!rateLimit) return true;
    const now = Date.now();
    let bucket = buckets.get(peer.id);
    if (!bucket || now - bucket.start >= rateLimit.windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(peer.id, bucket);
    }
    bucket.count += 1;
    return bucket.count <= rateLimit.messages;
  }

  async function dispatch(peer: Peer, text: string): Promise<void> {
    try {
      if (!allow(peer)) {
        peer.send({ t: "error", code: "rate_limited" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        peer.send({ t: "error", code: "bad_message" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        peer.send({ t: "error", code: "bad_message" });
        return;
      }
      const message = parsed as Record<string, unknown>;
      if (typeof message.t !== "string") {
        peer.send({ t: "error", code: "bad_message" });
        return;
      }

      switch (message.t) {
        case "ping": {
          peer.send({ t: "pong" });
          return;
        }
        case "hello":
        case "room_join": {
          const result = await hub.hello(peer, {
            room: message.room,
            session: message.session,
            passcode: message.passcode,
          });
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "claim": {
          const result = await hub.claim(peer, message.name);
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "vote_open": {
          // POKER-002: the deck is server-owned — only the title crosses.
          const result = await hub.openVote(peer, { title: message.title });
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "vote_cast":
        case "vote_change": {
          const result = await hub.castVote(peer, {
            voteId: message.voteId,
            choice: message.choice,
          });
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "vote_close": {
          const result = await hub.closeVote(peer, message.voteId);
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "vote_reopen": {
          const result = await hub.reopenVote(peer, message.voteId);
          if (!result.ok) peer.send({ t: "error", code: result.code });
          return;
        }
        case "room_create": {
          const result = await hub.createRoom({
            title: message.title,
            public: message.public,
            passcode: message.passcode,
          });
          if (!result.ok) peer.send({ t: "error", code: result.code });
          else peer.send({ t: "room_created", room: publicRoomSummary(result.room) });
          return;
        }
        case "room_list": {
          peer.send({ t: "rooms", rooms: await hub.listPublicRooms() });
          return;
        }
        case "history": {
          // Extension: the parent's §1.4 `history` frame. Clients may also use
          // GET /api/rooms/:code/history (§1.5).
          const votes = await hub.history(message.room ?? peer.room);
          if (votes === null) peer.send({ t: "error", code: "bad_room" });
          else peer.send({ t: "history", votes });
          return;
        }
        default: {
          peer.send({ t: "error", code: "bad_message" });
        }
      }
    } catch (error) {
      // A bad message must never kill the socket or the process (AC3).
      console.error("[poker] message handling failed:", error);
      peer.send({ t: "error", code: "server_error" });
    }
  }

  // -- wiring ----------------------------------------------------------------

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      console.error("[poker] request failed:", error);
      if (error instanceof RoomCorruptError) {
        sendJson(res, 500, { error: `room ${error.code} is corrupt` });
        return;
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on("upgrade", handleUpgrade);

  return {
    server,
    hub,
    db,
    dataDir,
    publicDir,
    startedAt,
    close(): Promise<void> {
      for (const connection of sockets) connection.destroy();
      sockets.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rejectUpgrade(socket: Socket, status: number, text: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } finally {
    socket.destroy();
  }
}

/**
 * POKER-008: a stamp for the served client assets — the newest mtime in
 * `public/`. It changes on a client deploy even when the server is not
 * restarted, so an open tab can detect that it is stale and reload. Never
 * throws: an unreadable directory is simply an empty stamp.
 */
async function assetBuild(dir: string): Promise<string> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let newest = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(path.join(dir, entry.name));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
    return newest > 0 ? String(Math.round(newest)) : "";
  } catch {
    return "";
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_MESSAGE_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

/**
 * Boot the server when this module is the entry point (not when imported by
 * `node --test`). Under pm2 fork mode argv[1] is pm2's ProcessContainerFork.js.
 */
export function isMainEntry(argv1: string | undefined, importUrl: string): boolean {
  if (importUrl === pathToFileURL(argv1 ?? "").href) return true;
  return path.basename(argv1 ?? "") === "ProcessContainerFork.js";
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  const app = createPokerServer();
  app.server.listen(resolvePort(process.env.PORT), () => {
    const address = app.server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    console.log(`poker on http://localhost:${port} — rooms in ${app.db.roomsDir}`);
  });
  const shutdown = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
