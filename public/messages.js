// public/messages.js — every error code the server can send (§1.4 / 001c note),
// mapped to a human sentence. Pure and dependency-free so a unit test can pin
// the contract: a new server error code without a message is a test failure.

export const ERROR_MESSAGES = Object.freeze({
  bad_message: "The server could not read that message.",
  bad_room: "No room with that code.",
  bad_session: "This browser's session id was rejected.",
  bad_passcode: "Wrong or missing passcode for that room.",
  not_in_room: "Join a room first.",
  name_taken: "That name is already taken in this room — pick another.",
  name_too_long: "That name is too long (24 characters max).",
  bad_name: "Please enter a name.",
  bad_title: "Please enter a title.",
  bad_options: "Add at least one option (one per line).",
  too_many_options: "Too many options (32 max).",
  too_many_votes: "This room has reached its vote limit (50).",
  room_full: "This room is full (200 members max).",
  bad_vote: "That vote no longer exists.",
  bad_choice: "That option is not part of this vote.",
  vote_closed: "That vote is closed — reopen it first.",
  vote_open: "That vote is already open.",
  rate_limited: "Slow down — too many messages at once.",
  server_error: "The server hit an unexpected error. Try again.",
});

/** A sentence for an error code; unknown codes name themselves. */
export function messageFor(code) {
  if (typeof code !== "string" || code === "") return "Something went wrong.";
  return ERROR_MESSAGES[code] ?? `Unexpected error: ${code}`;
}
