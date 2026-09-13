// public/store.js — the client's only persisted state (POKER-001c, parent §1.7).
//
// Pure, browser-global-free ES module: every function takes a `Storage`-like
// object so the exact same code runs in the browser (`window.localStorage`) and
// under `node --test` (`memoryStorage()` below). Nothing here ever talks to the
// server — My Rooms is client-only by contract, and the server must never grow
// a "recent rooms" endpoint (parent §1.1/§1.7).

/** The frozen localStorage keys, verbatim from parent §1.7. */
export const STORAGE_KEYS = Object.freeze({
  session: "poker.session",
  name: "poker.name",
  myRooms: "poker.myrooms",
  lastRoom: "poker.lastRoom",
});

/** A room code is 6 uppercase alphanumerics (mirrors lib/votes.ts normalizeCode). */
const CODE_RE = /^[A-Z0-9]{6}$/;

/** My Rooms is a convenience list, not a log — cap it so localStorage can't grow forever. */
export const MY_ROOMS_LIMIT = 50;

/** A Storage-like object is anything with getItem/setItem/removeItem. */
function asStorage(storage) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    throw new TypeError("store: a Storage-like object is required");
  }
  return storage;
}

/** Normalize a user-supplied room code; null when it is not a room code. */
export function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/**
 * An in-memory Storage implementation. Used as the browser fallback when
 * `localStorage` is unavailable (private mode) and by the unit tests.
 */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    return JSON.parse(raw);
  } catch {
    // A corrupt convenience store must never break the app.
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Session + name + last room
// ---------------------------------------------------------------------------

/** The anonymous identity: `"s-" + crypto.randomUUID()`, generated once (§1.7). */
export function ensureSession(storage, cryptoObj) {
  asStorage(storage);
  const existing = storage.getItem(STORAGE_KEYS.session);
  if (typeof existing === "string" && /^s-[0-9a-fA-F-]{8,}$/.test(existing.trim())) {
    return existing.trim();
  }
  if (!cryptoObj || typeof cryptoObj.randomUUID !== "function") {
    throw new TypeError("store: a crypto object with randomUUID() is required");
  }
  const session = `s-${cryptoObj.randomUUID()}`;
  storage.setItem(STORAGE_KEYS.session, session);
  return session;
}

export function readSession(storage) {
  asStorage(storage);
  const raw = storage.getItem(STORAGE_KEYS.session);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** The name is a prefill convenience only; the server owns the real name. */
export function readName(storage) {
  asStorage(storage);
  const raw = storage.getItem(STORAGE_KEYS.name);
  return typeof raw === "string" ? raw : "";
}

export function writeName(storage, name) {
  asStorage(storage);
  const clean = typeof name === "string" ? name.trim() : "";
  if (clean === "") storage.removeItem(STORAGE_KEYS.name);
  else storage.setItem(STORAGE_KEYS.name, clean);
  return clean;
}

export function readLastRoom(storage) {
  asStorage(storage);
  return normalizeCode(storage.getItem(STORAGE_KEYS.lastRoom));
}

export function writeLastRoom(storage, code) {
  asStorage(storage);
  const normalized = normalizeCode(code);
  if (!normalized) storage.removeItem(STORAGE_KEYS.lastRoom);
  else storage.setItem(STORAGE_KEYS.lastRoom, normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// My Rooms — [{ code, lastVisitAt }], most-recent-first (parent §1.7)
// ---------------------------------------------------------------------------

/** Read + sanitize + sort My Rooms. Corrupt entries are dropped, never thrown. */
export function readMyRooms(storage) {
  asStorage(storage);
  const raw = readJson(storage, STORAGE_KEYS.myRooms, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const code = normalizeCode(item.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const at = Number(item.lastVisitAt);
    entries.push({ code, lastVisitAt: Number.isFinite(at) ? at : 0 });
  }
  entries.sort((a, b) => b.lastVisitAt - a.lastVisitAt || a.code.localeCompare(b.code));
  return entries;
}

/** Persist My Rooms (most-recent-first), trimmed to the cap. */
export function writeMyRooms(storage, entries) {
  asStorage(storage);
  const clean = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const code = normalizeCode(entry?.code);
    if (!code) continue;
    const at = Number(entry?.lastVisitAt);
    clean.push({ code, lastVisitAt: Number.isFinite(at) ? at : 0 });
    if (clean.length >= MY_ROOMS_LIMIT) break;
  }
  storage.setItem(STORAGE_KEYS.myRooms, JSON.stringify(clean));
  return clean;
}

/**
 * Record a visit: the room moves to the front with a fresh `lastVisitAt`, and
 * re-visiting an existing room never duplicates it. Returns the new list.
 */
export function rememberRoom(storage, code, at = Date.now()) {
  asStorage(storage);
  const normalized = normalizeCode(code);
  if (!normalized) return readMyRooms(storage);
  const now = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const rest = readMyRooms(storage).filter((entry) => entry.code !== normalized);
  return writeMyRooms(storage, [{ code: normalized, lastVisitAt: now }, ...rest]);
}

export function forgetRoom(storage, code) {
  asStorage(storage);
  const normalized = normalizeCode(code);
  if (!normalized) return readMyRooms(storage);
  return writeMyRooms(
    storage,
    readMyRooms(storage).filter((entry) => entry.code !== normalized),
  );
}
