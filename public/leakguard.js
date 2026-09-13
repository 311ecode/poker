// public/leakguard.js — the anonymity scanner for OPEN vote frames (parent §1.2
// R1/R2, §1.4). Pure ES module, no browser globals, so the SAME code runs in
// the e2e specs (against Playwright's native `framereceived` wire frames) and in
// `node --test` (against synthetic leaking frames).
//
// The rule: a frame that carries an OPEN vote may contain aggregate `counts`
// and `votedCount` and nothing that ties a member to a ballot — no `name`, no
// `reveal`, no `ballots`, no per-person choice. This module is deliberately
// strict: the vote view must use exactly the allow-listed keys, so a new field
// added to the serializer has to be considered here explicitly.

/** Frame types whose payload is an open-vote view. */
export const OPEN_VOTE_FRAME_TYPES = Object.freeze(["vote_new", "vote_update", "vote_reopened"]);

/** Keys that must never appear in an open-vote frame (or an open vote in hello_ok). */
export const FORBIDDEN_OPEN_KEYS = Object.freeze([
  "name",
  "names",
  "reveal",
  "ballots",
  "ballot",
  "choice",
  "choices",
  "result",
  "votedBy",
  "voters",
  "individual",
]);

/** The exact key set `serializeVote()` emits for an open vote (lib/votes.ts). */
export const ALLOWED_OPEN_VOTE_KEYS = Object.freeze([
  "id",
  "title",
  "options",
  "state",
  "createdAt",
  "closedAt",
  "counts",
  "votedCount",
  "totalMembers",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse a wire payload into an object, or null when it is not JSON. */
export function parseFrame(payload) {
  if (isObject(payload)) return payload;
  if (typeof payload !== "string") return null;
  try {
    const parsed = JSON.parse(payload);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectForbidden(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbidden(item, `${path}[${index}]`, out));
    return out;
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_OPEN_KEYS.includes(key)) {
        out.push({ path: here, key, reason: "forbidden_key" });
      }
      collectForbidden(nested, here, out);
    }
  }
  return out;
}

function collectUnexpected(vote, path, out) {
  for (const key of Object.keys(vote)) {
    if (!ALLOWED_OPEN_VOTE_KEYS.includes(key)) {
      out.push({ path: path ? `${path}.${key}` : key, key, reason: "unexpected_key" });
    }
  }
  return out;
}

/** True when this frame carries an open vote that must be scanned. */
export function isOpenVoteFrame(message) {
  if (!isObject(message)) return false;
  if (OPEN_VOTE_FRAME_TYPES.includes(message.t)) {
    return isObject(message.vote) && message.vote.state !== "closed";
  }
  if (message.t === "hello_ok") {
    return (
      isObject(message.state) &&
      Array.isArray(message.state.votes) &&
      message.state.votes.some((vote) => isObject(vote) && vote.state !== "closed")
    );
  }
  return false;
}

/**
 * Every anonymity violation in one frame payload. Empty array = clean.
 * `vote_new` / `vote_update` / `vote_reopened` are scanned as a whole (a leak
 * could hide beside the vote); `hello_ok` is scanned per open vote only, since
 * its `you`/`room` blocks legitimately carry names.
 */
export function openVoteViolations(payload) {
  const message = parseFrame(payload);
  if (!message || !isOpenVoteFrame(message)) return [];
  const out = [];

  if (OPEN_VOTE_FRAME_TYPES.includes(message.t)) {
    collectForbidden(message, "", out);
    if (isObject(message.vote)) collectUnexpected(message.vote, "vote", out);
    return out;
  }

  // hello_ok: only the open vote views are subject to the rule.
  message.state.votes.forEach((vote, index) => {
    if (!isObject(vote) || vote.state === "closed") return;
    const path = `state.votes[${index}]`;
    collectForbidden(vote, path, out);
    collectUnexpected(vote, path, out);
  });
  return out;
}

/** Scan a list of raw wire frames; returns `[{ payload, path, key, reason }]`. */
export function openVoteViolationsInFrames(frames) {
  const out = [];
  for (const payload of frames ?? []) {
    for (const violation of openVoteViolations(payload)) {
      out.push({ payload, ...violation });
    }
  }
  return out;
}

/**
 * Keys that must never appear ANYWHERE in any frame while a vote is open —
 * `reveal` and `ballots` have no legitimate use on an open wire.
 */
export function revealKeysAnywhere(payload) {
  const message = parseFrame(payload);
  if (!message) return [];
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "reveal" || key === "ballots") found.push(key);
      walk(nested);
    }
  };
  walk(message);
  return found;
}

/** Scan a list of raw wire frames for `reveal`/`ballots` keys. */
export function revealKeysInFrames(frames) {
  const out = [];
  for (const payload of frames ?? []) {
    const keys = revealKeysAnywhere(payload);
    if (keys.length > 0) out.push({ payload, keys });
  }
  return out;
}
