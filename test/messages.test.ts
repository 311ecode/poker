// test/messages.test.ts — the client's error surface must cover every code the
// server can send (POKER-001c note / parent §1.4). A new server error code
// without a human sentence is a failure here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_MESSAGES, messageFor } from "../public/messages.js";

/** Every code documented in the POKER-001c server interface note (POKER-002 adds two). */
const DOCUMENTED_CODES = [
  "bad_message",
  "bad_room",
  "bad_session",
  "bad_passcode",
  "not_in_room",
  "name_taken",
  "name_too_long",
  "name_locked",
  "name_required",
  "bad_name",
  "bad_title",
  "too_many_votes",
  "room_full",
  "bad_vote",
  "bad_choice",
  "vote_closed",
  "vote_open",
  "rate_limited",
  "server_error",
];

test("every documented error code has a non-empty human message", () => {
  for (const code of DOCUMENTED_CODES) {
    assert.ok(code in ERROR_MESSAGES, `missing message for ${code}`);
    const message = messageFor(code);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0, `empty message for ${code}`);
    assert.ok(!message.startsWith("Unexpected error:"), `fallback used for ${code}`);
  }
});

test("unknown or empty codes degrade to a safe sentence, never throw", () => {
  assert.equal(messageFor("who_knows"), "Unexpected error: who_knows");
  assert.equal(messageFor(""), "Something went wrong.");
  assert.equal(messageFor(undefined), "Something went wrong.");
  assert.equal(messageFor(42), "Something went wrong.");
});

test("the messages object is frozen (a caller cannot mutate the contract)", () => {
  assert.throws(() => {
    ERROR_MESSAGES.bad_message = "hijacked";
  }, TypeError);
});
