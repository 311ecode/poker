// test/heartbeat.test.ts — POKER-018: the keepalive is what stops the tunnel
// from eating a quiet room's socket. The whole state machine runs on a fake
// clock here, so the test is instant and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHeartbeat, PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../public/heartbeat.js";

/** A controllable clock whose setInterval fires only when time is advanced. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setInterval: (fn, ms) => {
      const id = { fn, ms, next: t + ms, cleared: false };
      timers.push(id);
      return id;
    },
    clearInterval: (id) => {
      if (id) id.cleared = true;
    },
    advance(ms) {
      const target = t + ms;
      // Fire due timers in scheduled order, each seeing the time it was due —
      // a batch jump would make every callback observe the final time and
      // misreport how long the link has really been quiet.
      for (;;) {
        let earliest = null;
        for (const id of timers) {
          if (id.cleared) continue;
          if (id.next <= target && (earliest === null || id.next < earliest.next)) earliest = id;
        }
        if (earliest === null) break;
        t = earliest.next;
        earliest.next += earliest.ms;
        earliest.fn();
      }
      t = target;
    },
    get liveTimers() {
      return timers.filter((id) => !id.cleared).length;
    },
  };
}

test("POKER-018: it pings on the interval, and only after start()", () => {
  const clock = fakeClock();
  const sent = [];
  const hb = createHeartbeat({ send: (f) => sent.push(f), ...clock });

  clock.advance(PING_INTERVAL_MS * 3);
  assert.deepEqual(sent, [], "nothing is sent before start()");

  hb.start();
  clock.advance(PING_INTERVAL_MS - 1);
  assert.deepEqual(sent, [], "not early");

  clock.advance(1);
  assert.deepEqual(sent, [{ t: "ping" }], "one ping per interval");

  clock.advance(PING_INTERVAL_MS);
  assert.equal(sent.length, 2, "keeps pinging while the link is still fresh");
  assert.ok(sent.every((frame) => frame.t === "ping"), "only pings are sent");
  hb.stop();
});

test("POKER-018: traffic (a pong, a vote, anything) keeps the link alive", () => {
  const clock = fakeClock();
  const sent = [];
  let dead = 0;
  const hb = createHeartbeat({ send: (f) => sent.push(f), onDead: () => (dead += 1), ...clock });
  hb.start();

  // A server that answers every ping, for far longer than the timeout.
  for (let i = 0; i < 12; i += 1) {
    clock.advance(PING_INTERVAL_MS);
    hb.touch();
  }
  assert.equal(dead, 0, "an answering server never trips the dead link");
  assert.equal(sent.length, 12);
  hb.stop();
});

test("POKER-018 falsification: with no traffic at all the link is declared dead", () => {
  const clock = fakeClock();
  const sent = [];
  const dead = [];
  const hb = createHeartbeat({ send: (f) => sent.push(f), onDead: () => dead.push(clock.now()), ...clock });
  hb.start();

  // Pings keep going out (they are writes; a half-open socket never complains),
  // but nothing is ever touched — exactly the tunnel-eats-it case. The check runs
  // on a tick, so detection lands on the first tick at or after the timeout.
  const firstTickAfterTimeout = PING_TIMEOUT_MS + PING_INTERVAL_MS;
  clock.advance(firstTickAfterTimeout);
  assert.equal(dead.length, 1, "declared dead once silence passes the timeout");
  assert.equal(sent.length, 2, "it pinged on the way there, then stopped");

  const after = sent.length;
  clock.advance(PING_INTERVAL_MS * 4);
  assert.equal(sent.length, after, "a dead link is not pinged further");
  assert.equal(dead.length, 1, "and it is only declared dead once");
  assert.equal(clock.liveTimers, 0, "the interval is cleared");
  assert.equal(typeof hb.touch, "function", "the caller may still touch it harmlessly");
});

test("POKER-018: stop() is final and idempotent", () => {
  const clock = fakeClock();
  const sent = [];
  const hb = createHeartbeat({ send: (f) => sent.push(f), ...clock });
  hb.start();
  clock.advance(PING_INTERVAL_MS);
  assert.equal(sent.length, 1);

  hb.stop();
  hb.stop();
  clock.advance(PING_INTERVAL_MS * 5);
  assert.equal(sent.length, 1, "nothing after stop()");
  assert.equal(clock.liveTimers, 0, "no timer left behind");
});

test("POKER-018: send is required, loudly", () => {
  assert.throws(() => createHeartbeat({}), /send is required/);
});
