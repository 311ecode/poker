// public/heartbeat.js — POKER-018: keep the room socket alive.
//
// The frozen contract defines a JSON keepalive (POKER-001 §1.4): the client
// sends `{"t":"ping"}` and the server answers `{"t":"pong"}`. The server has
// always answered it (`server.ts`), but until POKER-018 nothing ever SENT one —
// so a quiet room (no votes being cast) carried no traffic at all, and the
// Cloudflare tunnel dropped the idle WebSocket at ~100-125s. The client then
// reconnected, went quiet again, and dropped again: the "connect / disconnect
// dance" every couple of minutes.
//
// No protocol change: this module only drives the ping the contract already
// specifies, and treats a link that has been silent for two intervals as dead so
// recovery does not have to wait for the proxy to time it out.
//
// Pure and timer-injectable on purpose: `test/heartbeat.test.ts` runs the whole
// state machine on a fake clock, including the falsification (no traffic → dead).

/** How often a live socket says something. Well under the proxy's ~100s idle cut. */
export const PING_INTERVAL_MS = 25_000;

/** Silence longer than this means the link is gone; reconnect rather than wait. */
export const PING_TIMEOUT_MS = 65_000;

/**
 * @param {object} options
 * @param {(frame: object) => unknown} options.send  write a protocol frame
 * @param {() => void} [options.onDead]              the link is gone: recover
 * @param {number} [options.intervalMs]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 * @param {Function} [options.setInterval]
 * @param {Function} [options.clearInterval]
 * @returns {{ start: () => void, stop: () => void, touch: () => void }}
 */
export function createHeartbeat(options) {
  const {
    send,
    onDead,
    intervalMs = PING_INTERVAL_MS,
    timeoutMs = PING_TIMEOUT_MS,
    now = () => Date.now(),
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
  } = options ?? {};
  if (typeof send !== "function") throw new TypeError("heartbeat: send is required");

  let timer = null;
  let stopped = false;
  let lastSeen = now();

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function tick() {
    if (stopped) return;
    if (now() - lastSeen >= timeoutMs) {
      // Nothing came back for two intervals — the tunnel ate the socket without
      // a close frame, which is exactly what the browser cannot see on its own.
      stop();
      onDead?.();
      return;
    }
    send({ t: "ping" });
  }

  function start() {
    if (stopped || timer !== null) return;
    lastSeen = now();
    timer = setIntervalFn(tick, intervalMs);
  }

  /** Every received frame proves the link is alive. */
  function touch() {
    lastSeen = now();
  }

  return { start, stop, touch };
}
