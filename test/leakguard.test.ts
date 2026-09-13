// test/leakguard.test.ts — the anonymity scanner's own falsification
// (parent §4.1.1): feed it synthetic LEAKING frames and prove it goes red, so
// the e2e assertion against real wire frames cannot silently pass on a leak.
// The server is not ours to break (001a owns it) — this is how the wire
// assertion is shown to be able to fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_OPEN_VOTE_KEYS,
  isOpenVoteFrame,
  openVoteViolations,
  openVoteViolationsInFrames,
  revealKeysAnywhere,
  revealKeysInFrames,
} from "../public/leakguard.js";

const cleanOpenVote = {
  id: "v1",
  title: "Who pays?",
  options: ["Heads", "Tails"],
  state: "open",
  createdAt: 1,
  closedAt: null,
  counts: { Heads: 1, Tails: 0 },
  votedCount: 1,
  totalMembers: 2,
};

test("a clean vote_update/open vote has no violations", () => {
  const frame = JSON.stringify({ t: "vote_update", vote: cleanOpenVote });
  assert.deepEqual(openVoteViolations(frame), []);
  assert.equal(isOpenVoteFrame(JSON.parse(frame)), true);
});

test("FALSIFICATION: a leaky open vote_update with `reveal` is caught", () => {
  const leaking = JSON.stringify({
    t: "vote_update",
    vote: { ...cleanOpenVote, reveal: [{ name: "Alice", choice: "Heads" }] },
  });
  const violations = openVoteViolations(leaking);
  assert.ok(violations.length >= 2, `expected violations, got ${JSON.stringify(violations)}`);
  assert.ok(violations.some((v) => v.key === "reveal" && v.reason === "forbidden_key"));
  // The nested name is caught too, so a payload cannot smuggle it inside reveal.
  assert.ok(violations.some((v) => v.key === "name"));
});

test("FALSIFICATION: `ballots`, a per-person choice and a bare name are caught", () => {
  const ballots = openVoteViolations({
    t: "vote_update",
    vote: { ...cleanOpenVote, ballots: [{ session: "s-1", choice: "Tails" }] },
  });
  assert.ok(ballots.some((v) => v.key === "ballots"));

  const choices = openVoteViolations({
    t: "vote_new",
    vote: { ...cleanOpenVote, choices: { "s-1": "Tails" } },
  });
  assert.ok(choices.some((v) => v.key === "choices"));

  const named = openVoteViolations({
    t: "vote_update",
    vote: { ...cleanOpenVote, name: "Alice" },
  });
  assert.ok(named.some((v) => v.key === "name"));
});

test("a non-allow-listed vote key is reported as unexpected (counts+votedCount only)", () => {
  const frame = { t: "vote_update", vote: { ...cleanOpenVote, extra: 1 } };
  const violations = openVoteViolations(frame);
  assert.deepEqual(violations, [{ path: "vote.extra", key: "extra", reason: "unexpected_key" }]);
  // The allow-list matches the serializer exactly.
  assert.deepEqual([...ALLOWED_OPEN_VOTE_KEYS].sort(), Object.keys(cleanOpenVote).sort());
});

test("hello_ok is scanned per open vote and does not false-positive on you/room names", () => {
  const frame = {
    t: "hello_ok",
    you: { session: "s-1", name: "Alice" },
    room: { code: "F4K2QH", title: "Friday" },
    state: { votes: [cleanOpenVote] },
  };
  assert.deepEqual(openVoteViolations(frame), []);

  const leaking = {
    ...frame,
    state: { votes: [{ ...cleanOpenVote, reveal: [{ name: "Alice", choice: "Heads" }] }] },
  };
  const violations = openVoteViolations(leaking);
  assert.ok(violations.some((v) => v.key === "reveal" && v.path.startsWith("state.votes[0]")));
});

test("closed votes are exempt: vote_closed legitimately reveals names", () => {
  const closed = {
    t: "vote_closed",
    vote: {
      ...cleanOpenVote,
      state: "closed",
      result: { Heads: 1, Tails: 1 },
      reveal: [{ name: "Alice", choice: "Heads" }],
    },
  };
  assert.deepEqual(openVoteViolations(closed), []);
  assert.equal(isOpenVoteFrame(closed), false);
});

test("presence, vote_you and non-vote frames are not subject to the rule", () => {
  assert.deepEqual(
    openVoteViolations({ t: "presence", members: [{ session: "s-1", name: "Alice", online: true }] }),
    [],
  );
  assert.deepEqual(openVoteViolations({ t: "vote_you", voteId: "v1", order: ["s-2", "s-1"], self: "s-1" }), []);
  assert.deepEqual(openVoteViolations("{not json"), []);
  assert.deepEqual(openVoteViolations(null), []);
  assert.deepEqual(openVoteViolations("[1,2,3]"), []);
});

test("reveal/ballots must never appear anywhere while a vote is open", () => {
  assert.deepEqual(revealKeysAnywhere(JSON.stringify({ t: "presence", members: [] })), []);
  const leak = { t: "vote_update", vote: cleanOpenVote, extra: { reveal: [] } };
  assert.deepEqual(revealKeysAnywhere(leak).sort(), ["reveal"]);
  const leaks = revealKeysInFrames([
    JSON.stringify({ t: "vote_new", vote: cleanOpenVote }),
    JSON.stringify({ t: "vote_update", vote: { ...cleanOpenVote, ballots: [] } }),
  ]);
  assert.equal(leaks.length, 1);
  assert.deepEqual(leaks[0]!.keys, ["ballots"]);
});

test("openVoteViolationsInFrames aggregates violations with their raw payload", () => {
  const frames = [
    JSON.stringify({ t: "vote_new", vote: cleanOpenVote }),
    JSON.stringify({ t: "presence", members: [{ name: "Bob" }] }),
    JSON.stringify({ t: "vote_update", vote: { ...cleanOpenVote, reveal: [{ name: "Bob", choice: "Tails" }] } }),
  ];
  const violations = openVoteViolationsInFrames(frames);
  assert.ok(violations.length >= 2);
  assert.ok(violations.every((v) => typeof v.payload === "string"));
  assert.ok(violations.every((v) => v.payload.includes("reveal") || v.key === "name"));
});
