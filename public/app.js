// public/app.js — the poker browser client (POKER-001c, dressed by POKER-001e).
//
// Plain ES module, no bundler, no build step (AC11). It owns the WebSocket
// (`/ws`), hash routing, the local My-Rooms store and every user flow: join,
// create, find, claim a name, open/cast/close/reopen, reveal and history.
//
// Anonymity (the one rule): while a vote is OPEN the vote card renders counts,
// `votedCount` and a NAME-FREE voter order. The server never sends names while
// open (parent §1.2 R1/R2) and neither does this client — do not add a name to
// the open vote card.
//
// POKER-001e adds only presentation: the generated ASCII banners (imported from
// lib/asciiFont.ts — served as ./asciiFont.js), the per-screen empty/loading/
// error states, the live tally, the reveal moment and the mobile fallback. No
// protocol or state logic changed; every landed `data-*` hook is intact.

import { renderBanner } from "./asciiFont.js";
import { createHeartbeat } from "./heartbeat.js";
import { messageFor } from "./messages.js";
import { openVoteViolations } from "./leakguard.js";
import {
  ensureSession,
  forgetPasscode,
  memoryStorage,
  readMyRooms,
  readName,
  readPasscode,
  readSelfChoices,
  readSession,
  rememberRoom,
  resetSession,
  writeLastRoom,
  writeName,
  writePasscode,
  writeSelfChoices,
} from "./store.js";

// ---------------------------------------------------------------------------
// storage + session (browser globals are injectable: see test/store.test.ts)
// ---------------------------------------------------------------------------

function pickStorage() {
  try {
    const probe = "__poker_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

const storage = pickStorage();
const session = ensureSession(storage, window.crypto);

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const state = {
  route: { name: "home" },
  connection: "closed",
  error: null,
  room: null,
  roomCode: null,
  passcode: "",
  you: { session, name: "" },
  // POKER-003: a claimed name is burned into localStorage for life, so the
  // client claims it silently in a new room and never re-claims where the server
  // already knows us. `claimRejected` re-opens the form if that name is taken.
  autoClaimSent: false,
  autoClaimTimer: null,
  claimRejected: false,
  members: [],
  votes: new Map(), // id -> vote view (counts only while open)
  orders: new Map(), // id -> { order: [session], self }
  selfChoices: new Map(), // id -> choice this browser cast (local only)
  rooms: [],
  roomsStatus: "idle", // idle | loading | ready | empty | error
  myRooms: readMyRooms(storage),
  history: [],
  historyStatus: "idle", // idle | loading | ready | empty | error
};

// A debug buffer of every frame RECEIVED by this page. It supplements the e2e
// specs' native `page.on("websocket")` capture, never replaces it (AC7).
const receivedFrames = [];
window.__pokerFrames = receivedFrames;

// Client-side supplement: any open-vote frame that looks like a leak is logged
// here (public/leakguard.js). The e2e assertion is on the raw wire; this is a
// cheap second pair of eyes and keeps the scanner on the real client path.
const leakLog = [];
window.__pokerLeaks = leakLog;

// Votes whose close is being presented as the "reveal moment" right now, and
// votes whose owner skipped that animation (AC7). Both are presentation-only:
// the reveal data is in the DOM the moment the frame lands.
const revealingVotes = new Set();
const skippedReveals = new Set();
const REVEAL_ANIMATION_MS = 2000;
// POKER-006: how long a silent claim may take before the form is revealed anyway.
const AUTO_CLAIM_GRACE_MS = 2500;
// POKER-008: how often an open tab checks whether it has been superseded.
const BUILD_POLL_MS = 60_000;

// ---------------------------------------------------------------------------
// dom
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  body: document.body,
  header: $("header.site-header"),
  homePanel: $('[data-panel="home"]'),
  roomPanel: $('[data-panel="room"]'),
  connection: $("[data-connection]"),
  connectionLine: $("[data-connection-line]"),
  error: $("[data-error]"),
  gate: $("[data-gate]"),
  gateForm: $('[data-form="retry-join"]'),
  nameGate: $("[data-name-gate]"),
  retryCard: $("[data-retry]"),
  retryButton: $('[data-action="retry-connect"]'),
  share: $("[data-share]"),
  sharePasscode: $("[data-share-passcode]"),
  inviteUrl: $("[data-invite-url]"),
  inviteIncludePasscode: $('[data-input="invite-include-passcode"]'),
  roomSections: $$('[data-panel="room"] section[data-section]'),
  roomCode: $("[data-room-code]"),
  roomTitle: $("[data-room-title]"),
  roomBanner: $("[data-room-banner]"),
  youName: $("[data-you-name]"),
  youSession: $("[data-you-session]"),
  youLine: $("[data-you-line]"),
  passcodeLine: $("[data-room-passcode-line]"),
  passcodeValue: $("[data-room-passcode]"),
  claimSlot: $("[data-claim-slot]"),
  claimForm: $('[data-form="claim"]'),
  openVoteForm: $('[data-form="open-vote"]'),
  needName: $("[data-need-name]"),
  members: $("[data-members]"),
  votes: $("[data-votes]"),
  myRooms: $("[data-my-rooms]"),
  rooms: $("[data-rooms]"),
  history: $("[data-history]"),
  emptyRooms: $('[data-empty="rooms"]'),
  emptyMyRooms: $('[data-empty="my-rooms"]'),
  emptyMembers: $('[data-empty="members"]'),
  emptyVotes: $('[data-empty="votes"]'),
  emptyHistory: $('[data-empty="history"]'),
  joinCode: $('[data-input="join-code"]'),
  createTitle: $('[data-input="create-title"]'),
  createPasscode: $('[data-input="create-passcode"]'),
  createPublic: $('[data-input="create-public"]'),
  nameInput: $('[data-input="name"]'),
  voteTitle: $('[data-input="vote-title"]'),
  roomPasscode: $('[data-input="room-passcode"]'),
};

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// banners (POKER-001e) — generated from lib/asciiFont.ts, never hand-drawn
// ---------------------------------------------------------------------------

// AC9: the banner folds below 480px. The value is mirrored in public/style.css;
// `data-banner-mode` is the hook that proves the two agree.
const COMPACT_QUERY = "(max-width: 480px)";
const compactQuery = window.matchMedia(COMPACT_QUERY);
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function bannerMode() {
  return compactQuery.matches ? "compact" : "full";
}

/** Fill an existing banner block: <pre> block art + single-row compact text. */
function setBannerText(container, text) {
  if (!container) return;
  const value = typeof text === "string" ? text : "";
  container.setAttribute("data-banner-text", value);
  container.setAttribute("aria-label", value || "banner");
  const pre = container.querySelector("[data-banner-pre]");
  const compact = container.querySelector("[data-banner-compact]");
  if (pre) pre.textContent = renderBanner(value).join("\n");
  if (compact) compact.textContent = value;
  container.setAttribute("data-banner-mode", bannerMode());
}

/** Build a banner block (used for vote titles and the reveal moment). */
function bannerNode(text, options = {}) {
  const wrap = el("div", {
    class: `banner ${options.className ?? ""}`.trim(),
    "data-banner": "",
    "data-banner-mode": bannerMode(),
    role: "img",
  });
  wrap.append(
    el("pre", { class: "banner-pre", "data-banner-pre": "", "aria-hidden": "true" }),
    el("p", { class: "banner-compact", "data-banner-compact": "", "aria-hidden": "true" }),
  );
  for (const [key, value] of Object.entries(options.attrs ?? {})) wrap.setAttribute(key, value);
  setBannerText(wrap, text);
  return wrap;
}

/** Render the static banners declared in index.html (their text is in markup). */
function renderStaticBanners() {
  for (const node of $$("[data-banner][data-banner-text]")) {
    if (node.hasAttribute("data-room-banner")) continue; // per-route, see renderRoute
    setBannerText(node, node.getAttribute("data-banner-text"));
  }
}

/** Keep every banner's mode hook in step with the CSS breakpoint. */
function applyBannerMode() {
  for (const node of $$("[data-banner]")) node.setAttribute("data-banner-mode", bannerMode());
}

// ---------------------------------------------------------------------------
// websocket
// ---------------------------------------------------------------------------

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 250;
// POKER-018: the keepalive that stops the tunnel from dropping a quiet socket.
let heartbeat = null;
// POKER-020: "hello sent, nothing came back" must not be a dead end either.
let helloTimeout = null;
const HELLO_TIMEOUT_MS = 10_000;
// One self-heal attempt per room per refusal, so a persistent refusal cannot loop.
let resyncedNameFor = null;
let resyncedSessionFor = null;

function wsUrl() {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function setConnection(value) {
  state.connection = value;
  els.connection.setAttribute("data-connection", value);
  els.connection.textContent = value;
}

function closeSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearAutoClaimTimer();
  // POKER-018: this nulls `socket` before closing, so the socket's own close
  // handler bails — the keepalive must be stopped here or it outlives the socket.
  heartbeat?.stop();
  heartbeat = null;
  clearHelloTimeout();
  const current = socket;
  socket = null;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
    current.close();
  }
}

/** POKER-020: cancel the "hello got no answer" guard. */
function clearHelloTimeout() {
  if (helloTimeout) {
    clearTimeout(helloTimeout);
    helloTimeout = null;
  }
}

/** Connect (or reconnect) the single socket to `state.roomCode`. */
function connect() {
  if (!state.roomCode) return;
  closeSocket();
  // A fresh socket may need the silent claim again; a rejected name does not
  // (it would just fail identically).
  state.autoClaimSent = false;
  setConnection("connecting");
  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    reconnectDelay = 250;
    setConnection("open");
    const hello = { t: "hello", room: state.roomCode, session: state.you.session };
    if (state.passcode) hello.passcode = state.passcode;
    send(hello);
    // POKER-018: speak up every 25s. A quiet room carries no traffic otherwise,
    // and the Cloudflare tunnel closes an idle WebSocket at ~100-125s — which is
    // the connect/disconnect dance the user saw. `onDead` closes the socket, so
    // the ordinary close handler does the reconnecting.
    heartbeat?.stop();
    heartbeat = createHeartbeat({
      send: (frame) => {
        if (socket === ws) send(frame);
      },
      onDead: () => {
        try {
          ws.close();
        } catch {
          /* the close handler owns recovery */
        }
      },
    });
    heartbeat.start();
    // POKER-020: if the server says NOTHING at all back, this socket is useless —
    // close it so the ordinary close handler reconnects, instead of sitting on a
    // "connecting" screen forever.
    clearHelloTimeout();
    helloTimeout = setTimeout(() => {
      helloTimeout = null;
      if (socket === ws) {
        try {
          ws.close();
        } catch {
          /* the close handler owns recovery */
        }
      }
    }, HELLO_TIMEOUT_MS);
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    // Any inbound frame — the pong, a presence broadcast, nothing special — is
    // proof the link is alive.
    heartbeat?.touch();
    clearHelloTimeout();
    const payload = typeof event.data === "string" ? event.data : String(event.data);
    receivedFrames.push(payload);
    const leaks = openVoteViolations(payload);
    if (leaks.length > 0) leakLog.push({ payload, leaks });
    let message = null;
    try {
      message = JSON.parse(payload);
    } catch {
      showError("bad_message");
      return;
    }
    handleMessage(message);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    heartbeat?.stop();
    heartbeat = null;
    clearHelloTimeout();
    setConnection("closed");
    if (state.roomCode) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (state.roomCode) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 4000);
    }
  });

  ws.addEventListener("error", () => {
    /* the close handler owns recovery */
  });
}

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

/** Cancel a pending POKER-006 stall guard. */
function clearAutoClaimTimer() {
  if (state.autoClaimTimer) {
    clearTimeout(state.autoClaimTimer);
    state.autoClaimTimer = null;
  }
}

/**
 * POKER-003: use the name burned into this browser, never re-claim it.
 * - the server already knows this session → `hello_ok.you.name` is used as-is;
 *   the client sends NO `claim` frame at all;
 * - a new room → claim the stored name once, silently;
 * - nothing stored, or the stored name was rejected here → the form is the path.
 *
 * POKER-006: the silent claim must never be a dead end. If it has not landed
 * within the grace period the claim form is revealed, prefilled, so an unnamed
 * visitor is never stuck (and never shown as a bare session id).
 */
function autoClaimStoredName() {
  if ((state.you.name ?? "") !== "") {
    clearAutoClaimTimer();
    return;
  }
  if (state.route.name !== "room") return;
  if (state.autoClaimSent || state.claimRejected) return;
  const stored = readName(storage).trim();
  if (stored === "") return;
  state.autoClaimSent = true;
  if (!send({ t: "claim", name: stored })) {
    state.autoClaimSent = false;
    return;
  }
  const roomAtSend = state.roomCode;
  clearAutoClaimTimer();
  state.autoClaimTimer = setTimeout(() => {
    state.autoClaimTimer = null;
    const stuck =
      state.roomCode === roomAtSend &&
      state.route.name === "room" &&
      (state.you.name ?? "") === "";
    if (stuck) {
      state.claimRejected = true;
      renderChrome();
    }
  }, AUTO_CLAIM_GRACE_MS);
}

function handleMessage(message) {
  if (!message || typeof message.t !== "string") return;
  switch (message.t) {
    case "hello_ok": {
      state.room = message.room ?? null;
      state.roomCode = message.room?.code ?? state.roomCode;
      state.you = { session: message.you?.session ?? state.you.session, name: message.you?.name ?? "" };
      state.votes = new Map();
      state.orders = new Map();
      for (const vote of message.state?.votes ?? []) state.votes.set(vote.id, vote);
      clearError();
      rememberRoom(storage, state.roomCode);
      writeLastRoom(storage, state.roomCode);
      state.myRooms = readMyRooms(storage);
      state.history = [];
      state.historyStatus = "idle";
      // POKER-007: this browser was admitted with a passcode, so remember it for
      // this room — an admitted member can read it back and share it.
      if (state.roomCode && state.passcode) writePasscode(storage, state.roomCode, state.passcode);
      renderAll();
      // POKER-003: if the server does not know this session yet but a name is
      // burned into this browser, claim it silently — the form never appears.
      autoClaimStoredName();
      return;
    }
    case "presence": {
      state.members = Array.isArray(message.members) ? message.members : [];
      renderMembers();
      return;
    }
    case "claim_ok": {
      state.you = { session: message.you?.session ?? state.you.session, name: message.you?.name ?? "" };
      state.claimRejected = false;
      clearAutoClaimTimer();
      writeName(storage, state.you.name);
      clearError();
      renderYou();
      // POKER-002 AC5: claiming flips the gate, so the vote cards (disabled for
      // an unnamed viewer) must be re-rendered immediately.
      renderVotes();
      return;
    }
    case "vote_new":
    case "vote_update":
    case "vote_reopened": {
      const vote = message.vote;
      if (vote && typeof vote.id === "string") {
        state.votes.set(vote.id, vote);
        // Reopen (or a fresh vote) returns to the anonymous state (R6): no
        // reveal and no reveal animation may linger.
        revealingVotes.delete(vote.id);
        skippedReveals.delete(vote.id);
      }
      renderVotes();
      return;
    }
    case "vote_closed": {
      const vote = message.vote;
      if (vote && typeof vote.id === "string") {
        state.votes.set(vote.id, vote);
        // AC7: the reveal moment is presentation only — the data is rendered
        // synchronously below; this timer only retires the CSS animation.
        revealingVotes.add(vote.id);
        skippedReveals.delete(vote.id);
        const id = vote.id;
        setTimeout(() => {
          if (revealingVotes.delete(id)) renderVotes();
        }, REVEAL_ANIMATION_MS);
      }
      renderVotes();
      return;
    }
    case "vote_you": {
      if (typeof message.voteId === "string") {
        state.orders.set(message.voteId, {
          order: Array.isArray(message.order) ? message.order : [],
          self: message.self ?? state.you.session,
        });
      }
      renderVotes();
      return;
    }
    case "rooms": {
      state.rooms = Array.isArray(message.rooms) ? message.rooms : [];
      state.roomsStatus = state.rooms.length > 0 ? "ready" : "empty";
      renderRooms();
      return;
    }
    case "room_created": {
      const code = message.room?.code;
      if (code) goToRoom(code, state.passcode);
      return;
    }
    case "history": {
      state.history = Array.isArray(message.votes) ? message.votes : [];
      state.historyStatus = state.history.length > 0 ? "ready" : "empty";
      renderHistory();
      return;
    }
    case "pong":
      return;
    case "error": {
      const code = typeof message.code === "string" ? message.code : "server_error";
      // POKER-020: two refusals mean "the server already holds an identity for
      // this session" or "the identity you sent is junk". Both are recoverable,
      // and neither may leave the visitor trapped in a gate. Exactly one attempt
      // per room, so a persistent refusal cannot turn into a loop.
      if (code === "name_locked" && state.route.name === "room" && state.roomCode) {
        // A lost claim_ok (the old connection dance did this), or a second tab
        // that claimed first. Ask the server who we already are, instead of
        // asking the visitor again for a name that cannot change.
        if (resyncedNameFor !== state.roomCode) {
          resyncedNameFor = state.roomCode;
          clearError();
          const hello = { t: "hello", room: state.roomCode, session: state.you.session };
          if (state.passcode) hello.passcode = state.passcode;
          send(hello);
          return;
        }
      }
      if (code === "bad_session" && state.route.name === "room" && state.roomCode) {
        // A session id the server will not accept: mint a fresh one and re-open.
        if (resyncedSessionFor !== state.roomCode) {
          resyncedSessionFor = state.roomCode;
          state.you.session = resetSession(storage, window.crypto);
          clearError();
          connect();
          return;
        }
      }
      // POKER-006: an unnamed visitor must never be left with no way to claim.
      // Any refusal except "you are not in this room" re-opens the form (a taken
      // or locked stored name included).
      const admission = ["bad_passcode", "bad_room", "bad_session", "not_in_room"];
      if (
        state.route.name === "room" &&
        (state.you.name ?? "") === "" &&
        !admission.includes(code)
      ) {
        state.claimRejected = true;
      }
      showError(code);
      return;
    }
    default:
      return;
  }
}

function showError(code) {
  state.error = code;
  els.error.setAttribute("data-error", code);
  els.error.textContent = messageFor(code);
  els.error.hidden = false;
  // POKER-017 (D3 extras): never keep retrying a passcode the server just
  // refused — it was either stale (a rotated passcode) or mistyped, and the gate
  // is right there to ask again.
  if (code === "bad_passcode" && state.roomCode) forgetPasscode(storage, state.roomCode);
  renderChrome();
  if (state.historyStatus === "loading") {
    state.historyStatus = "error";
    renderHistory();
  }
}

function clearError() {
  state.error = null;
  els.error.setAttribute("data-error", "");
  els.error.textContent = "";
  renderChrome();
  els.error.hidden = true;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function parseHash(hash = window.location.hash) {
  const raw = (hash || "").replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  if (segments[0] === "room" && segments[1]) {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "room", code: segments[1].toUpperCase(), passcode: params.get("passcode") ?? "" };
  }
  return { name: "home" };
}

function applyRoute() {
  const route = parseHash();
  state.route = route;
  // A stale error from a previous route must not follow the user around; each
  // hello/claim refreshes it.
  clearError();
  if (route.name === "room") {
    const changed = state.roomCode !== route.code;
    state.roomCode = route.code;
    // POKER-017 (D3 extras): a passcode-less link must not re-prompt a browser
    // that was already admitted here. The accepted passcode is remembered per
    // room (POKER-007's store), so a refresh or a re-open goes straight in; a
    // stale one is dropped the moment the server refuses it (see showError).
    state.passcode = route.passcode || readPasscode(storage, route.code) || "";
    state.room = changed ? null : state.room;
    if (changed) {
      resyncedNameFor = null;
      resyncedSessionFor = null;
      state.votes = new Map();
      state.orders = new Map();
      // POKER-003: a new room gets a fresh silent-claim attempt; a name refused
      // in a PREVIOUS room must not keep the form hidden here.
      state.autoClaimSent = false;
      state.claimRejected = false;
      clearAutoClaimTimer();
      // POKER-002: this browser's own ballots, restored so "my vote" survives
      // a reload and a vote reopen. Client-only mirror of the server ballot.
      state.selfChoices = new Map(readSelfChoices(storage, route.code));
      state.members = [];
      state.history = [];
      state.historyStatus = "idle";
      revealingVotes.clear();
      skippedReveals.clear();
      connect();
    }
  } else {
    state.roomCode = null;
    state.room = null;
    state.passcode = "";
    closeSocket();
    // POKER-015: `closeSocket()` nulls `socket` before closing, so the socket's
    // own `close` handler bails (`if (socket !== ws) return`) and never resets
    // this. Set it here or home keeps a stale green "open" with no socket.
    setConnection("closed");
  }
  renderAll();
}

function goToRoom(code, passcode) {
  const query = passcode ? `?passcode=${encodeURIComponent(passcode)}` : "";
  window.location.hash = `#/room/${code}${query}`;
}

// ---------------------------------------------------------------------------
// rendering — every hook the e2e specs assert on
// ---------------------------------------------------------------------------

function renderAll() {
  renderRoute();
  renderYou();
  renderChrome();
  renderMembers();
  renderVotes();
  renderMyRooms();
  renderRooms();
  renderHistory();
}

/**
 * POKER-019: is the claim form the path right now? True only inside a room this
 * browser has been admitted to, unnamed, and with no stored name to fall back on
 * (or a stored one this room refused — POKER-006's stall guard sets that flag).
 *
 * This one predicate drives both the claim form's lifetime (POKER-005) and the
 * `name` room state, so the form and the gate can never disagree.
 */
function nameIsThePath() {
  if (state.route.name !== "room" || !state.room) return false;
  if ((state.you.name ?? "") !== "") return false;
  const stored = readName(storage).trim();
  return stored === "" || state.claimRejected;
}

/**
 * POKER-017/POKER-019: where a room screen is in the entry flow.
 *   connecting — hello sent, not admitted yet, no refusal
 *   gate       — refused for a passcode: the gate is the only thing on screen
 *   missing    — no such room: the header alert carries it, no room furniture
 *   retry      — admitted refused for any OTHER reason (bad session, server
 *                error, rate limit): an explicit way forward, never a dead
 *                "connecting" screen (POKER-020)
 *   name       — admitted, but unidentified: the name gate, and nothing else
 *   live       — admitted and named: the real room
 *   home       — not a room at all
 */
function roomState() {
  if (state.route.name !== "room") return "home";
  if (!state.room) {
    if (state.error === "bad_passcode") return "gate";
    if (state.error === "bad_room") return "missing";
    // POKER-020: any other refusal gets an explicit retry, not a dead end.
    if (state.error) return "retry";
    return "connecting";
  }
  return nameIsThePath() ? "name" : "live";
}

/**
 * POKER-017: the invite link (D3-c). Code-only by default — the passcode is a
 * shared secret and a URL is written to browser history — and includable only
 * when the sharer ticks the box. The URL is built from `origin`, so it is right
 * on every host (localhost, the tunnel, a test port).
 */
function inviteUrl() {
  if (!state.roomCode) return "";
  const includable = els.inviteIncludePasscode?.checked === true;
  const passcode = includable ? readPasscode(storage, state.roomCode) : "";
  const query = passcode ? `?passcode=${encodeURIComponent(passcode)}` : "";
  return `${window.location.origin}/#/room/${state.roomCode}${query}`;
}

/**
 * POKER-017/POKER-019: the entry flow around a room — the passcode gate, the name
 * gate, the invite line, and the one `[data-error]` alert node placed next to the
 * field it is about. Presentation of existing state only: no protocol, and the
 * anonymity rules are untouched.
 * Returns the room state name (see `roomState`).
 */
function renderEntryFlow() {
  const inRoom = state.route.name === "room";
  const view = roomState();
  const live = view === "live";
  const gated = view === "gate";
  const naming = view === "name";
  const retrying = view === "retry";
  // Before admission we do not even know the room, so its title banner would be
  // an empty "ROOM" — hide it. While naming we DO know it, so it stays as context.
  const contextless = inRoom && (gated || retrying || view === "missing");

  els.roomPanel.setAttribute("data-room-state", view);
  if (els.gate) els.gate.hidden = !gated;
  if (els.nameGate) els.nameGate.hidden = !naming;
  if (els.retryCard) els.retryCard.hidden = !retrying;
  // The room's furniture belongs to a member: gone while gated, missing, or
  // still being named.
  for (const section of els.roomSections) section.hidden = inRoom && !live;
  if (els.roomBanner) els.roomBanner.hidden = contextless;
  // The invite link is a member's tool — a name comes first.
  if (els.share) els.share.hidden = !live;
  if (els.inviteUrl && live) els.inviteUrl.value = inviteUrl();
  const knownPasscode = live && state.roomCode ? readPasscode(storage, state.roomCode) : "";
  if (els.sharePasscode) els.sharePasscode.hidden = knownPasscode === "";
  // One alert node, where it is actionable: inside whichever gate is asking, in
  // the header everywhere else (POKER-015's placement).
  if (els.error) {
    const host = naming
      ? els.nameGate
      : gated
        ? els.gate
        : retrying
          ? els.retryCard
          : els.header;
    if (els.error.parentElement !== host) {
      if (gated && els.gateForm) els.gate.insertBefore(els.error, els.gateForm);
      else if (naming && els.claimSlot) els.nameGate.insertBefore(els.error, els.claimSlot);
      else if (retrying && els.retryButton) els.retryCard.insertBefore(els.error, els.retryButton);
      else els.header?.append(els.error);
    }
  }
  // D3 extras: the cursor starts where the visitor must type. A gate is the only
  // job on screen, so it takes focus unless the visitor is already typing in it
  // (never steal focus mid-edit — and the click that opened it left focus on a
  // control that has just been hidden). Home only takes focus when nothing else
  // has it, and never pops the mobile keyboard.
  const target = gated
    ? els.roomPasscode
    : naming
      ? els.nameInput
      : retrying
        ? els.retryButton
        : view === "home"
          ? els.joinCode
          : null;
  const gateHost = gated
    ? els.gate
    : naming
      ? els.nameGate
      : retrying
        ? els.retryCard
        : null;
  const active = document.activeElement;
  if (target && gateHost) {
    const insideGate = active && typeof gateHost.contains === "function" && gateHost.contains(active);
    if (!insideGate) target.focus({ preventScroll: true });
  } else if (target && document.activeElement === els.body && !compactQuery.matches) {
    target.focus({ preventScroll: true });
  }
  return view;
}

function renderRoute() {
  const inRoom = state.route.name === "room";
  els.body.setAttribute("data-view", inRoom ? "room" : "home");
  els.homePanel.hidden = inRoom;
  els.roomPanel.hidden = !inRoom;
  // POKER-015: the connection line reports the ROOM socket. Outside a room
  // there is no socket, so any value it could show would be a lie — hide it.
  if (els.connectionLine) els.connectionLine.hidden = !inRoom;
  els.roomCode.textContent = state.roomCode ?? "";
  els.roomTitle.textContent = state.room?.title ?? "";
  if (inRoom) els.roomPasscode.value = state.passcode ?? "";
  // AC4: the room screen always has a banner — the room's own title, or ROOM.
  setBannerText(els.roomBanner, (state.room?.title ?? "").trim() || "ROOM");
}

function renderYou() {
  els.youName.textContent = state.you.name ?? "";
  els.youSession.textContent = state.you.session ?? "";
}

/**
 * POKER-002/003/005: the room stays lean and a claimed name is final. The claim
 * form is physically REMOVED from the DOM once a name exists — no claim, no
 * rename — and inserted only when it is genuinely the path (in a room, unnamed,
 * no stored name, or a stored name this room refused). The passcode retry form
 * appears only when a protected room refused admission.
 */
function renderChrome() {
  const inRoom = state.route.name === "room";
  const view = renderEntryFlow();
  const live = view === "live";
  const named = (state.you.name ?? "") !== "";
  const storedName = readName(storage).trim();
  // POKER-019: the claim form is shown exactly while the name gate is up, and
  // removed from the DOM the moment a name exists (POKER-005). One predicate, so
  // the form and `data-room-state="name"` cannot disagree.
  const claimable = nameIsThePath();

  if (els.claimForm && els.claimSlot) {
    if (claimable) {
      if (!els.claimForm.isConnected) {
        els.claimSlot.append(els.claimForm);
        // POKER-006: prefill the stored name whenever the form (re)appears, not
        // only at module boot — entering a room is a hash change, not a reload,
        // so a rejected stored name must still be editable here. Never clobber
        // something the visitor has already typed.
        if (els.nameInput && els.nameInput.value === "") els.nameInput.value = storedName;
      }
      els.claimForm.hidden = false;
    } else if (els.claimForm.isConnected) {
      els.claimForm.remove();
    }
  }
  if (els.youLine) els.youLine.hidden = !inRoom || !named;
  if (els.openVoteForm) els.openVoteForm.hidden = !inRoom || !named;
  // POKER-019: the hint is for a named member who has not claimed — an unnamed
  // visitor never sees the votes at all, so it belongs to the live room only.
  if (els.needName) els.needName.hidden = !live || named;

  // POKER-007: the room's passcode, for admitted members only (it is this
  // browser's own copy — the server never sends a passcode). POKER-019: a name
  // comes first, so it is hidden while the name gate is up.
  const roomPasscode = live && state.roomCode ? readPasscode(storage, state.roomCode) : "";
  if (els.passcodeLine) els.passcodeLine.hidden = roomPasscode === "";
  if (els.passcodeValue && roomPasscode !== "") els.passcodeValue.textContent = roomPasscode;
}

function renderMembers() {
  const items = state.members.map((member) => {
    const li = el("li", {
      "data-member": "",
      "data-member-session": member.session,
      "data-member-name": member.name,
      "data-member-online": member.online ? "true" : "false",
    });
    // POKER-006: never show a bare session id — an unnamed member says so.
    li.textContent = `${member.name || "not named yet"}${member.online ? " (online)" : ""}`;
    return li;
  });
  els.members.replaceChildren(...items);
  els.members.setAttribute("data-members-state", items.length > 0 ? "ready" : "empty");
  els.emptyMembers.hidden = items.length > 0;
}

/**
 * The label for one voter slot. While a vote is OPEN the vote card must carry
 * no member name (parent §1.2 R1/R2), so the label is positional — a name
 * belongs in the reveal only. `presence` deliberately is NOT consulted here.
 */
function voterLabel(index, isSelf) {
  return isSelf ? `Voter ${index + 1} (you)` : `Voter ${index + 1}`;
}

/** AC6: live "N of M voted" + progress, no per-person attribution while open. */
function tallyBlock(vote) {
  const voted = Number(vote.votedCount ?? 0);
  const total = Number(vote.totalMembers ?? 0);
  const tally = el("div", { class: "tally", "data-tally": "" });

  const line = el("p", { class: "tally-line" });
  line.append(el("span", { "data-voted-count": "" }, String(voted)));
  line.append(document.createTextNode(" of "));
  line.append(el("span", { "data-total-members": "" }, String(total)));
  line.append(document.createTextNode(" voted"));
  tally.append(line);

  const progress = el("div", {
    class: "progress",
    "data-vote-progress": "",
    role: "progressbar",
    "aria-valuemin": "0",
    "aria-valuemax": String(total),
    "aria-valuenow": String(voted),
  });
  const fill = el("span", { class: "progress-fill", "data-progress-fill": "" });
  fill.style.width = total > 0 ? `${Math.round((voted / total) * 100)}%` : "0%";
  progress.append(fill);
  tally.append(progress);
  return tally;
}

/**
 * POKER-002 AC4: this viewer's own choice for a vote, or null. While open it is
 * the client-side mirror (`state.selfChoices`, per room, localStorage-backed);
 * once closed it can also be read from the public reveal by our own name.
 */
function selfChoiceFor(vote) {
  const local = state.selfChoices.get(vote.id);
  if (typeof local === "string" && local !== "") return local;
  if (vote.state === "closed" && state.you.name && Array.isArray(vote.reveal)) {
    const mine = vote.reveal.find((entry) => entry?.name === state.you.name);
    if (mine && typeof mine.choice === "string") return mine.choice;
  }
  return null;
}

function voteCard(vote) {
  const card = el("article", { "data-vote": "", "data-vote-id": vote.id, "data-vote-state": vote.state });
  // The vote title is a generated banner (AC4); the plain heading stays for
  // assistive tech and for the landed hook vocabulary.
  card.append(bannerNode(vote.title ?? "", { className: "banner--card", attrs: { "data-vote-banner": "" } }));
  card.append(el("h3", { "data-vote-title": "", class: "visually-hidden" }, vote.title ?? ""));

  card.append(tallyBlock(vote));

  const mine = selfChoiceFor(vote);
  const named = (state.you.name ?? "") !== "";
  const open = vote.state === "open";

  // POKER-002 AC4: say it in words AND mark the card, so "what is my vote" is
  // never a guess. While open it stays changeable (round 2 = same world).
  const yourVote = el("p", { class: "your-vote", "data-your-vote": "" });
  if (mine !== null) {
    yourVote.append(document.createTextNode("Your vote: "));
    yourVote.append(el("strong", { "data-your-choice": "" }, mine));
  } else if (open && named) {
    yourVote.classList.add("your-vote--none");
    yourVote.textContent = "Your vote: not cast yet";
  } else {
    yourVote.hidden = true;
  }
  card.append(yourVote);

  // POKER-004: one select, sent the moment it changes — no button, no submit.
  const picker = el("p", { class: "choice-picker" });
  const select = el("select", {
    "data-choice-select": "",
    "aria-label": "Your vote",
    // POKER-002/004: no name or a closed vote → not votable.
    disabled: open && named ? undefined : "disabled",
  });
  select.append(
    el("option", { value: "", "data-choice-placeholder": "", disabled: "disabled" }, "— choose a value —"),
  );
  for (const option of vote.options ?? []) {
    const count = vote.counts?.[option] ?? 0;
    select.append(
      el(
        "option",
        { value: option, "data-choice": option, "data-count": String(count) },
        `${option} (${count})`,
      ),
    );
  }
  // The current value IS my own ballot (POKER-002 mirror): visible, changeable.
  select.value = mine ?? "";
  picker.append(select);
  card.append(picker);

  // While OPEN: a name-free voter order, per-viewer, self last (R2/R3/R4, AC5).
  if (vote.state === "open") {
    const order = state.orders.get(vote.id)?.order ?? [];
    const list = el("ol", { "data-voters": "", "data-voters-count": String(order.length) });
    order.forEach((voterSession, index) => {
      const isSelf = voterSession === state.you.session;
      list.append(
        el(
          "li",
          {
            "data-voter": "",
            "data-voter-session": voterSession,
            "data-voter-position": String(index + 1),
            "data-voter-self": isSelf ? "true" : "false",
            // Explicit anonymity hook: an open-vote row never carries a name.
            "data-voter-nameless": "true",
          },
          voterLabel(index, isSelf),
        ),
      );
    });
    card.append(list);
  }

  // Closed: names + choices are revealed to everyone (R5).
  if (vote.state === "closed") {
    const reveal = el("div", { "data-reveal": "" });
    const animating = revealingVotes.has(vote.id) && !reduceMotionQuery.matches;
    reveal.setAttribute(
      "data-reveal-animation",
      animating ? "on" : skippedReveals.has(vote.id) ? "skipped" : "off",
    );

    // The big-letter reveal moment (AC7). Text is present immediately; only the
    // CSS animation is conditional.
    reveal.append(
      bannerNode("REVEAL", { className: "banner--reveal banner--card", attrs: { "data-reveal-banner": "" } }),
    );

    // Per-option bars, scaled to the winner.
    const counts = vote.result ?? vote.counts ?? {};
    const optionsList = vote.options?.length ? vote.options : Object.keys(counts);
    const entries = optionsList.map((option) => [option, Number(counts[option] ?? 0)]);
    const max = entries.reduce((top, [, count]) => Math.max(top, count), 0);
    const bars = el("div", { class: "result-bars", "data-result-bars": "" });
    for (const [option, count] of entries) {
      const row = el("div", {
        class: "result-bar",
        "data-result-bar": "",
        "data-result-option": option,
        "data-result-count": String(count),
      });
      row.append(el("span", { class: "result-bar-label" }, option));
      const track = el("span", { class: "result-bar-track" });
      const fill = el("span", { class: "result-bar-fill", "data-result-fill": "" });
      fill.style.width = max > 0 ? `${Math.round((count / max) * 100)}%` : "0%";
      track.append(fill);
      row.append(track);
      row.append(el("span", { class: "result-bar-value", "data-result-value": "" }, String(count)));
      bars.append(row);
    }
    reveal.append(bars);

    // The named list, exactly the landed hook vocabulary.
    const list = el("ul", { "data-reveal-list": "" });
    const revealed = Array.isArray(vote.reveal) ? vote.reveal : [];
    for (const entry of revealed) {
      list.append(
        el(
          "li",
          {
            "data-reveal-entry": "",
            "data-reveal-name": entry.name,
            "data-reveal-choice": entry.choice,
          },
          `${entry.name} → ${entry.choice}`,
        ),
      );
    }
    if (revealed.length === 0) {
      list.append(el("li", { class: "empty", "data-empty": "reveal" }, "No ballots were cast."));
    }
    reveal.append(list);

    // AC7: the animation is skippable — and skipping never hides the data.
    if (animating) {
      reveal.append(el("button", { type: "button", "data-action": "skip-reveal" }, "Skip animation"));
    }
    card.append(reveal);
  }

  const close = el("button", { type: "button", "data-action": "close-vote" }, "Close vote");
  close.hidden = vote.state !== "open";
  const reopen = el("button", { type: "button", "data-action": "reopen-vote" }, "Reopen vote");
  reopen.hidden = vote.state !== "closed";
  card.append(close, reopen);
  return card;
}

function renderVotes() {
  // POKER-011: rebuilding the cards destroys the focused control, which drops
  // focus to <body> and can scroll the page to the top — exactly what must not
  // happen while someone is voting. Capture the scroll offset and the focused
  // vote select first, then restore both in this same task so nothing paints in
  // between (the list is rebuilt twice per vote: optimistic + server echo).
  const scroller = document.scrollingElement || document.documentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const focused = document.activeElement;
  const focusedVoteId =
    focused && focused.matches?.("[data-choice-select]")
      ? (focused.closest("[data-vote]")?.getAttribute("data-vote-id") ?? null)
      : null;

  const cards = [...state.votes.values()].map((vote) => voteCard(vote));
  els.votes.replaceChildren(...cards);
  els.votes.setAttribute("data-votes-state", cards.length > 0 ? "ready" : "empty");
  els.emptyVotes.hidden = cards.length > 0;

  if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  if (focusedVoteId) {
    const select = els.votes.querySelector(
      `[data-vote-id="${focusedVoteId}"] [data-choice-select]`,
    );
    // preventScroll: re-focusing must not move the page either.
    select?.focus?.({ preventScroll: true });
  }
}

function renderMyRooms() {
  const items = state.myRooms.map((entry) => {
    const li = el("li", {
      "data-my-room": "",
      "data-my-room-code": entry.code,
      "data-last-visit": String(entry.lastVisitAt),
    });
    const open = el("button", { type: "button", "data-action": "open-room", "data-open-room": entry.code }, entry.code);
    li.append(open, document.createTextNode(` — ${new Date(entry.lastVisitAt).toISOString()}`));
    return li;
  });
  els.myRooms.replaceChildren(...items);
  els.myRooms.setAttribute("data-my-rooms-state", items.length > 0 ? "ready" : "empty");
  els.emptyMyRooms.hidden = items.length > 0;
}

function renderRooms() {
  const status = state.roomsStatus;
  const items = state.rooms.map((room) => {
    const li = el("li", {
      "data-room-summary": "",
      "data-room-summary-code": room.code,
      "data-has-passcode": room.hasPasscode ? "true" : "false",
      "data-members": String(room.members ?? 0),
    });
    li.append(document.createTextNode(`${room.code} — ${room.title} `));
    const join = el("button", { type: "button", "data-action": "open-room", "data-open-room": room.code }, "open");
    if (room.hasPasscode) join.setAttribute("data-needs-passcode", "true");
    li.append(join);
    return li;
  });
  els.rooms.replaceChildren(...items);
  els.rooms.setAttribute("data-rooms-state", status);
  const messages = {
    idle: "Press “Find rooms” to list public rooms.",
    loading: "Loading rooms…",
    empty: "No public rooms yet — create one.",
    error: "Could not load rooms — try again.",
    ready: "",
  };
  els.emptyRooms.textContent = messages[status] ?? "";
  els.emptyRooms.hidden = status === "ready";
}

function renderHistory() {
  const status = state.historyStatus;
  const items = state.history.map((vote) => {
    const closed = vote.state === "closed";
    const li = el("li", {
      "data-history-vote": "",
      "data-history-vote-id": vote.id,
      "data-history-state": vote.state,
      "data-history-final": closed ? "true" : "false",
    });
    li.append(el("h4", {}, vote.title ?? ""));
    // Open votes in history carry counts only (no reveal); closed ones carry the
    // final result (AC8).
    li.append(
      el(
        "p",
        { "data-history-counts": "" },
        Object.entries(vote.counts ?? {})
          .map(([choice, count]) => `${choice}: ${count}`)
          .join(", "),
      ),
    );
    const events = el("ul", { "data-history-events": "" });
    for (const event of vote.events ?? []) {
      events.append(
        el(
          "li",
          { "data-history-event": "", "data-event-kind": event.kind, "data-event-at": String(event.at) },
          `${event.kind} @ ${new Date(event.at).toISOString()}`,
        ),
      );
    }
    li.append(events);
    if (vote.reveal) {
      const reveal = el("ul", { "data-history-reveal": "" });
      for (const entry of vote.reveal) {
        reveal.append(
          el(
            "li",
            { "data-history-reveal-entry": "", "data-reveal-name": entry.name, "data-reveal-choice": entry.choice },
            `${entry.name} → ${entry.choice}`,
          ),
        );
      }
      li.append(reveal);
    }
    return li;
  });
  els.history.replaceChildren(...items);
  els.history.setAttribute("data-history-state", status);
  const messages = {
    idle: "History not loaded yet — press “Load history”.",
    loading: "Loading history…",
    empty: "No votes in this room yet.",
    error: "Could not load history — try again.",
    ready: "",
  };
  els.emptyHistory.textContent = messages[status] ?? "";
  els.emptyHistory.hidden = status === "ready";
}

// ---------------------------------------------------------------------------
// user actions
// ---------------------------------------------------------------------------

async function createRoom() {
  const title = els.createTitle.value.trim();
  const passcode = els.createPasscode.value;
  const isPublic = els.createPublic.checked;
  let response;
  try {
    response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, public: isPublic, passcode: passcode || undefined }),
    });
  } catch {
    showError("server_error");
    return;
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    showError(typeof body.error === "string" ? body.error : "server_error");
    return;
  }
  clearError();
  const code = body.room?.code;
  if (code) {
    state.passcode = passcode;
    goToRoom(code, passcode);
  }
}

async function findRooms() {
  state.roomsStatus = "loading";
  renderRooms();
  try {
    const response = await fetch("/api/rooms");
    const body = await response.json();
    state.rooms = Array.isArray(body.rooms) ? body.rooms : [];
    state.roomsStatus = state.rooms.length > 0 ? "ready" : "empty";
  } catch {
    state.roomsStatus = "error";
    showError("server_error");
  }
  renderRooms();
}

function castVote(voteId, choice) {
  // POKER-002 AC5: mirror the server gate locally instead of firing a doomed cast.
  if ((state.you.name ?? "") === "") {
    showError("name_required");
    return;
  }
  const type = state.selfChoices.has(voteId) ? "vote_change" : "vote_cast";
  if (send({ t: type, voteId, choice })) {
    // POKER-002 AC4: remember it locally (and across reloads) so the mark and
    // the "Your vote" line are immediate, not a wait for the echo.
    state.selfChoices.set(voteId, choice);
    if (state.roomCode) {
      writeSelfChoices(storage, state.roomCode, [...state.selfChoices.entries()]);
    }
    renderVotes();
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$('[data-form="join"]').addEventListener("submit", (event) => {
  event.preventDefault();
  const code = els.joinCode.value.trim().toUpperCase();
  // POKER-017 (D2-A): Home carries no passcode field. An empty code is a no-op
  // (the cursor is already in the field); a protected room answers at the gate.
  if (code === "") {
    els.joinCode.focus({ preventScroll: true });
    return;
  }
  goToRoom(code);
});

$('[data-form="create"]').addEventListener("submit", (event) => {
  event.preventDefault();
  void createRoom();
});

$('[data-action="find-rooms"]').addEventListener("click", () => void findRooms());

// POKER-020: the explicit way out of a refusal that is not about the passcode.
$('[data-action="retry-connect"]').addEventListener("click", () => {
  clearError();
  connect();
});

$('[data-form="retry-join"]').addEventListener("submit", (event) => {
  event.preventDefault();
  state.passcode = els.roomPasscode.value;
  connect();
});

// POKER-007: copy this room's passcode so an admitted member can share it.
$('[data-action="copy-passcode"]').addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const passcode = readPasscode(storage, state.roomCode);
  if (!passcode) return;
  try {
    await navigator.clipboard.writeText(passcode);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  } catch {
    // Clipboard can be unavailable (permissions/insecure context) — the code is
    // on screen to read, so a failed copy is not worth an error banner.
  }
});

// POKER-017 (D3-c): copy the room's invite link. Code-only by default; the
// passcode is appended only while the "include passcode" box is ticked, so a
// shared secret never lands in a URL by accident.
$('[data-action="copy-invite-link"]').addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const url = inviteUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
  } catch {
    // Clipboard can be unavailable (permissions/insecure context): the link is
    // in the readonly field next to the button, so select it for a manual copy.
    if (els.inviteUrl) {
      els.inviteUrl.focus();
      els.inviteUrl.select();
    }
  }
});

$('[data-input="invite-include-passcode"]').addEventListener("change", () => {
  if (els.inviteUrl) els.inviteUrl.value = inviteUrl();
});

$('[data-form="claim"]').addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.nameInput.value.trim();
  if (name === "") {
    showError("bad_name");
    return;
  }
  send({ t: "claim", name });
});

$('[data-form="open-vote"]').addEventListener("submit", (event) => {
  event.preventDefault();
  if ((state.you.name ?? "") === "") {
    showError("name_required");
    return;
  }
  // POKER-002 AC1: the deck is server-owned; only the question is sent.
  // POKER-012: once it is on the wire the box is consumed — clear it so the next
  // vote starts empty. Only this opener clears (vote_new is a broadcast, so
  // reacting to it would wipe someone else's half-typed question).
  if (send({ t: "vote_open", title: els.voteTitle.value.trim() })) {
    els.voteTitle.value = "";
  }
});

$('[data-action="load-history"]').addEventListener("click", () => {
  state.historyStatus = "loading";
  renderHistory();
  if (!send({ t: "history", room: state.roomCode })) {
    state.historyStatus = "error";
    showError("server_error");
    renderHistory();
  }
});

els.votes.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const voteId = target.closest("[data-vote]")?.getAttribute("data-vote-id");
  if (!voteId) return;
  const action = target.getAttribute("data-action");
  if (action === "close-vote") send({ t: "vote_close", voteId });
  else if (action === "reopen-vote") send({ t: "vote_reopen", voteId });
  else if (action === "skip-reveal") {
    // AC7: skipping is presentation only — the reveal data stays on screen.
    revealingVotes.delete(voteId);
    skippedReveals.add(voteId);
    renderVotes();
  }
});

// POKER-004: the vote value is chosen from a select and sent the moment it
// changes — there is no cast button and nothing else to click.
els.votes.addEventListener("change", (event) => {
  const select = event.target.closest("[data-choice-select]");
  if (!select) return;
  const voteId = select.closest("[data-vote]")?.getAttribute("data-vote-id");
  const choice = select.value;
  if (!voteId || typeof choice !== "string" || choice === "") return;
  castVote(voteId, choice);
});

for (const container of [els.myRooms, els.rooms]) {
  container.addEventListener("click", (event) => {
    const target = event.target.closest('[data-action="open-room"]');
    if (!target) return;
    goToRoom(target.getAttribute("data-open-room"), "");
  });
}

document.querySelector('[data-action="home"]').addEventListener("click", () => {
  window.location.hash = "#/";
});

window.addEventListener("hashchange", () => applyRoute());
// The banner's mobile fallback is a CSS breakpoint; keep the mode hook honest.
compactQuery.addEventListener?.("change", () => applyBannerMode());

// debug/test hook: the e2e robustness spec needs to put a hostile payload on
// the real socket. This is the ONLY test-only surface (AC10).
window.__pokerTest = {
  sendRaw(text) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(String(text));
      return true;
    }
    return false;
  },
  closeSocket() {
    if (socket) socket.close();
  },
  socketState() {
    return socket ? socket.readyState : -1;
  },
  session: () => state.you.session,
  room: () => state.roomCode,
  myRooms: () => readMyRooms(storage),
  // POKER-008: the self-update probe, so the e2e can drive it deterministically.
  checkBuild: () => checkBuild(),
};

// ---------------------------------------------------------------------------
// self-update (POKER-008)
// ---------------------------------------------------------------------------
//
// A tab left open across a deploy keeps its old modules forever (the socket
// reconnects; the page does not reload). The server stamps its client assets on
// /api/health, so this page can notice it has been superseded and reload itself.
// A reload is safe: rooms, votes, the claimed name and the viewer's own ballot
// all live server-side or in localStorage.

let knownBuild = null;
try {
  knownBuild = window.sessionStorage.getItem("poker.build");
} catch {
  knownBuild = null;
}

function rememberBuild(value) {
  knownBuild = value;
  try {
    window.sessionStorage.setItem("poker.build", value);
  } catch {
    /* storage unavailable — the in-memory value still guards this page */
  }
}

async function checkBuild() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json();
    const build = typeof body?.build === "string" ? body.build : "";
    if (build === "") return;
    if (knownBuild === null) {
      rememberBuild(build);
      return;
    }
    if (build !== knownBuild) {
      // Store it FIRST: the reloaded page then compares equal and cannot loop.
      rememberBuild(build);
      window.location.reload();
    }
  } catch {
    /* offline — the next tick tries again */
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

els.nameInput.value = readName(storage);
if (!readSession(storage)) {
  // ensureSession above already persisted it; this is a defensive re-check.
  ensureSession(storage, window.crypto);
}
setConnection("closed");
renderStaticBanners();
applyBannerMode();
applyRoute();

// POKER-008: keep an open tab from running a superseded client.
void checkBuild();
setInterval(() => void checkBuild(), BUILD_POLL_MS);
window.addEventListener("focus", () => void checkBuild());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void checkBuild();
});
