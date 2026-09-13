// lib/ws.ts — hand-rolled RFC 6455 server-side framing (POKER-001a AC3,
// parent §1.8). ZERO runtime dependencies: no `ws`, no `socket.io`.
//
// Implements the subset this app uses and the parts a hostile client will
// exercise: text + binary frames, continuation/fragmentation, ping/pong,
// close, 7/16/64-bit payload lengths, and unmasking of masked client→server
// frames. A declared message larger than `maxMessageBytes` is *discarded
// without buffering* and reported, so an oversized frame costs O(1) memory
// and the socket survives (the server answers `bad_message`).

import { createHash } from "node:crypto";
import type { Socket } from "node:net";

/** RFC 6455 handshake GUID. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Default per-message ceiling — matches POKER-001a AC11's 64 KiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function websocketAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** XOR a payload with a 4-byte masking key, in place. */
export function unmask(payload: Buffer, key: Buffer): Buffer {
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i & 3]!;
  return payload;
}

export interface WsHandlers {
  onText?(text: string): void;
  onBinary?(data: Buffer): void;
  onPing?(data: Buffer): void;
  onPong?(data: Buffer): void;
  /** A close frame arrived from the peer. */
  onCloseFrame?(code: number, reason: string): void;
  /** A message exceeded `maxMessageBytes`; the bytes were discarded. */
  onTooLarge?(size: number): void;
  /** Framing violation; the connection is closed with 1002 afterwards. */
  onProtocolError?(detail: string): void;
  /** The underlying socket is gone (once). */
  onClosed?(): void;
}

export interface WsOptions {
  maxMessageBytes?: number;
}

export class WebSocketConnection {
  private readonly socket: Socket;
  private readonly handlers: WsHandlers;
  readonly maxMessageBytes: number;

  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;

  // Oversize handling: skip `discardRemaining` bytes without buffering them.
  private discarding = false;
  private discardRemaining = 0;
  private discardFin = false;
  private oversizeBytes = 0;

  private closeSent = false;
  private finished = false;

  constructor(socket: Socket, handlers: WsHandlers = {}, options: WsOptions = {}) {
    this.socket = socket;
    this.handlers = handlers;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    socket.on("data", (chunk: Buffer) => this.push(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    // Half-open sockets must not linger.
    socket.setNoDelay?.(true);
  }

  get closed(): boolean {
    return this.finished;
  }

  /** Feed raw bytes from the socket (including the post-upgrade `head`). */
  push(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
    this.parse();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.handlers.onClosed?.();
  }

  private protocolError(detail: string): void {
    this.handlers.onProtocolError?.(detail);
    this.sendClose(1002, detail.slice(0, 120));
    this.end();
  }

  private parse(): void {
    while (!this.finished) {
      if (this.discarding) {
        if (this.discardRemaining > 0) {
          if (this.buffer.length === 0) return;
          const take = Math.min(this.discardRemaining, this.buffer.length);
          this.buffer = this.buffer.subarray(take);
          this.discardRemaining -= take;
        }
        if (this.discardRemaining > 0) return;
        if (this.discardFin) {
          const size = this.oversizeBytes;
          this.discarding = false;
          this.discardFin = false;
          this.oversizeBytes = 0;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = 0;
          this.handlers.onTooLarge?.(size);
        }
        if (this.buffer.length < 2) return;
      }

      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) return this.protocolError("reserved bits set");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if ((big & (1n << 63n)) !== 0n) return this.protocolError("invalid 64-bit length");
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.protocolError("length too large");
        length = Number(big);
        offset = 10;
      }

      if (masked) {
        if (this.buffer.length < offset + 4) return;
        offset += 4;
      }

      const isControl = opcode >= 0x8;
      if (isControl) {
        if (!fin) return this.protocolError("fragmented control frame");
        if (length > 125) return this.protocolError("control frame too large");
        if (opcode !== OPCODE.CLOSE && opcode !== OPCODE.PING && opcode !== OPCODE.PONG) {
          return this.protocolError("unknown control opcode");
        }
      } else if (opcode !== OPCODE.CONTINUATION && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
        return this.protocolError("unknown opcode");
      }

      if (this.discarding) {
        // Continuation frames of an oversize message: skip the payload.
        this.buffer = this.buffer.subarray(offset);
        this.discardRemaining = length;
        this.discardFin = fin;
        continue;
      }

      if (!isControl) {
        const total = this.fragmentBytes + length;
        if (total > this.maxMessageBytes) {
          // Enter discard mode for this frame's payload; keep the connection.
          this.buffer = this.buffer.subarray(offset);
          this.discarding = true;
          this.discardRemaining = length;
          this.discardFin = fin;
          this.oversizeBytes = total;
          continue;
        }
      }

      if (this.buffer.length < offset + length) return;
      const maskKey = masked ? this.buffer.subarray(offset - 4, offset) : null;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskKey) unmask(payload, maskKey);
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === OPCODE.CLOSE) {
        let code = 1005;
        let reason = "";
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString("utf8");
        }
        this.handlers.onCloseFrame?.(code, reason);
        this.sendClose(code === 1005 ? 1000 : code, "");
        this.end();
        return;
      }
      if (opcode === OPCODE.PING) {
        this.handlers.onPing?.(payload);
        this.sendFrame(OPCODE.PONG, payload);
        continue;
      }
      if (opcode === OPCODE.PONG) {
        this.handlers.onPong?.(payload);
        continue;
      }

      if (opcode === OPCODE.CONTINUATION) {
        if (this.fragmentOpcode === 0) return this.protocolError("continuation without start");
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
      } else {
        if (this.fragmentOpcode !== 0) return this.protocolError("new message during fragmented message");
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      }

      if (fin) {
        const message =
          this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments, this.fragmentBytes);
        const kind = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = 0;
        if (kind === OPCODE.TEXT) this.handlers.onText?.(message.toString("utf8"));
        else this.handlers.onBinary?.(message);
      }
    }
  }

  // -- outbound --------------------------------------------------------------

  sendText(text: string): void {
    this.sendFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  ping(data: Buffer = Buffer.alloc(0)): void {
    this.sendFrame(OPCODE.PING, data);
  }

  sendClose(code = 1000, reason = ""): void {
    if (this.closeSent || this.finished) return;
    this.closeSent = true;
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.sendFrame(OPCODE.CLOSE, payload);
  }

  /** Graceful close: send the close frame, then FIN the socket. */
  end(): void {
    if (!this.closeSent) this.sendClose(1000, "");
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  /** Hard teardown (server shutdown / protocol violation). */
  destroy(): void {
    this.finished = true;
    this.socket.destroy();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closeSent && opcode !== OPCODE.CLOSE) return;
    if (this.finished || this.socket.destroyed) return;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = payload.length;
    } else if (payload.length < 65_536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(header);
      if (payload.length > 0) this.socket.write(payload);
    } catch {
      this.destroy();
    }
  }
}
