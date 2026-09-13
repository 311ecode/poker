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
import { messageFor } from "./messages.js";
import { openVoteViolations } from "./leakguard.js";
import {
  ensureSession,
  memoryStorage,
  readMyRooms,
  readName,
  readSession,
  rememberRoom,
  writeLastRoom,
  writeName,
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

// ---------------------------------------------------------------------------
// dom
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  body: document.body,
  homePanel: $('[data-panel="home"]'),
  roomPanel: $('[data-panel="room"]'),
  connection: $("[data-connection]"),
  error: $("[data-error]"),
  roomCode: $("[data-room-code]"),
  roomTitle: $("[data-room-title]"),
  roomBanner: $("[data-room-banner]"),
  youName: $("[data-you-name]"),
  youSession: $("[data-you-session]"),
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
  joinPasscode: $('[data-input="join-passcode"]'),
  createTitle: $('[data-input="create-title"]'),
  createPasscode: $('[data-input="create-passcode"]'),
  createPublic: $('[data-input="create-public"]'),
  nameInput: $('[data-input="name"]'),
  voteTitle: $('[data-input="vote-title"]'),
  voteOptions: $('[data-input="vote-options"]'),
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
  const current = socket;
  socket = null;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
    current.close();
  }
}

/** Connect (or reconnect) the single socket to `state.roomCode`. */
function connect() {
  if (!state.roomCode) return;
  closeSocket();
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
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
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
      renderAll();
      return;
    }
    case "presence": {
      state.members = Array.isArray(message.members) ? message.members : [];
      renderMembers();
      return;
    }
    case "claim_ok": {
      state.you = { session: message.you?.session ?? state.you.session, name: message.you?.name ?? "" };
      writeName(storage, state.you.name);
      clearError();
      renderYou();
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
      showError(typeof message.code === "string" ? message.code : "server_error");
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
  if (state.historyStatus === "loading") {
    state.historyStatus = "error";
    renderHistory();
  }
}

function clearError() {
  state.error = null;
  els.error.setAttribute("data-error", "");
  els.error.textContent = "";
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
    state.passcode = route.passcode ?? "";
    state.room = changed ? null : state.room;
    if (changed) {
      state.votes = new Map();
      state.orders = new Map();
      state.selfChoices = new Map();
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
  renderMembers();
  renderVotes();
  renderMyRooms();
  renderRooms();
  renderHistory();
}

function renderRoute() {
  const inRoom = state.route.name === "room";
  els.body.setAttribute("data-view", inRoom ? "room" : "home");
  els.homePanel.hidden = inRoom;
  els.roomPanel.hidden = !inRoom;
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

function renderMembers() {
  const items = state.members.map((member) => {
    const li = el("li", {
      "data-member": "",
      "data-member-session": member.session,
      "data-member-name": member.name,
      "data-member-online": member.online ? "true" : "false",
    });
    li.textContent = `${member.name || member.session}${member.online ? " (online)" : ""}`;
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

function voteCard(vote) {
  const card = el("article", { "data-vote": "", "data-vote-id": vote.id, "data-vote-state": vote.state });
  // The vote title is a generated banner (AC4); the plain heading stays for
  // assistive tech and for the landed hook vocabulary.
  card.append(bannerNode(vote.title ?? "", { className: "banner--card", attrs: { "data-vote-banner": "" } }));
  card.append(el("h3", { "data-vote-title": "", class: "visually-hidden" }, vote.title ?? ""));

  card.append(tallyBlock(vote));

  const options = el("ul", { "data-options": "" });
  for (const option of vote.options ?? []) {
    const count = vote.counts?.[option] ?? 0;
    const attrs = {
      type: "button",
      "data-choice": option,
      "data-count": String(count),
      disabled: vote.state === "open" ? undefined : "disabled",
    };
    if (state.selfChoices.get(vote.id) === option) attrs["data-self-choice"] = "true";
    const button = el("button", attrs);
    button.append(document.createTextNode(`${option} (`));
    button.append(el("span", { "data-count-value": "" }, String(count)));
    button.append(document.createTextNode(")"));
    const item = el("li");
    item.append(button);
    options.append(item);
  }
  card.append(options);

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
  const cards = [...state.votes.values()].map((vote) => voteCard(vote));
  els.votes.replaceChildren(...cards);
  els.votes.setAttribute("data-votes-state", cards.length > 0 ? "ready" : "empty");
  els.emptyVotes.hidden = cards.length > 0;
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
  if (send({ t: "vote_cast", voteId, choice })) {
    state.selfChoices.set(voteId, choice);
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$('[data-form="join"]').addEventListener("submit", (event) => {
  event.preventDefault();
  const code = els.joinCode.value.trim().toUpperCase();
  goToRoom(code, els.joinPasscode.value);
});

$('[data-form="create"]').addEventListener("submit", (event) => {
  event.preventDefault();
  void createRoom();
});

$('[data-action="find-rooms"]').addEventListener("click", () => void findRooms());

$('[data-form="retry-join"]').addEventListener("submit", (event) => {
  event.preventDefault();
  state.passcode = els.roomPasscode.value;
  connect();
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
  const options = els.voteOptions.value
    .split("\n")
    .map((option) => option.trim())
    .filter((option) => option !== "");
  send({ t: "vote_open", title: els.voteTitle.value.trim(), options });
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
  const target = event.target.closest("[data-action], [data-choice]");
  if (!target) return;
  const voteId = target.closest("[data-vote]")?.getAttribute("data-vote-id");
  if (!voteId) return;
  if (target.hasAttribute("data-choice")) {
    castVote(voteId, target.getAttribute("data-choice"));
    return;
  }
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
};

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
