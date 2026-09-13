// lib/asciiFont.ts — the Matrix-style banner font (POKER-001e).
//
// A 5-row block-letter font, generated from a glyph TABLE (never hand-drawn
// pictures): every glyph is five rows of exactly CELL_WIDTH visual columns, and
// `renderBanner(text)` composes them into five rows of equal VISUAL width.
//
// Two things this module exists to get right:
//
//   * AC1 — one glyph table for `A–Z 0–9 space - . _` plus a `?` fallback, and
//     a renderer that always returns exactly five rows.
//   * AC2 — width is VISUAL width, never `String.length`. The glyphs use the
//     Block Elements range `U+2500–U+259F` (`█`), which Unicode classifies as
//     East-Asian *Ambiguous*: a terminal (and every browser) renders it one
//     cell wide, but a naive "is this East-Asian wide?" table would call it two
//     and desync every row. `visualWidth()` therefore counts that range as ONE
//     cell and is the only width measure used here.
//
// Delivery note (no build step): this file is written in type-free JavaScript
// syntax so the SAME bytes are both enforced by `node --test`
// (`test/asciiFont.test.ts`) and served to the browser, which imports it as
// `./asciiFont.js`. `public/asciiFont.js` is a symlink to this file: the static
// server only serves `public/`, and a `.js` URL gets the `text/javascript`
// content-type the ES-module loader requires. One module, no copy, no drift.

/** Banner height in terminal rows (AC1). */
export const BANNER_ROWS = 5;

/** Every glyph cell is this many visual columns wide (AC1/AC2). */
export const CELL_WIDTH = 5;

/** One blank column between two glyphs. */
export const SEPARATOR = " ";

/** The glyph used for anything not in the table — never desync the row width. */
export const FALLBACK_GLYPH = "?";

const ON = "█"; // U+2588 FULL BLOCK — in U+2500–U+259F (East-Asian Ambiguous → 1 cell).

/** The glyph table (AC1): `A–Z`, `0–9`, space, `-`, `.`, `_`, and the fallback. */
export const GLYPHS = Object.freeze({
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  B: ["████ ", "█   █", "████ ", "█   █", "████ "],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  G: [" ████", "█    ", "█  ██", "█   █", " ████"],
  H: ["█   █", "█   █", "█████", "█   █", "█   █"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  J: ["█████", "   █ ", "   █ ", "█  █ ", " ██  "],
  K: ["█   █", "█  █ ", "███  ", "█  █ ", "█   █"],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  P: ["████ ", "█   █", "████ ", "█    ", "█    "],
  Q: [" ███ ", "█   █", "█   █", "█  █ ", " ██ █"],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  U: ["█   █", "█   █", "█   █", "█   █", " ███ "],
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  X: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
  Z: ["█████", "   █ ", "  █  ", " █   ", "█████"],
  0: [" ███ ", "█  ██", "█ █ █", "██  █", " ███ "],
  1: ["  █  ", " ██  ", "  █  ", "  █  ", "█████"],
  2: [" ███ ", "█   █", "  ██ ", " █   ", "█████"],
  3: ["████ ", "    █", " ███ ", "    █", "████ "],
  4: ["█  █ ", "█  █ ", "█████", "   █ ", "   █ "],
  5: ["█████", "█    ", "████ ", "    █", "████ "],
  6: [" ███ ", "█    ", "████ ", "█   █", " ███ "],
  7: ["█████", "   █ ", "  █  ", " █   ", "█    "],
  8: [" ███ ", "█   █", " ███ ", "█   █", " ███ "],
  9: [" ███ ", "█   █", " ████", "    █", " ███ "],
  " ": ["     ", "     ", "     ", "     ", "     "],
  "-": ["     ", "     ", " ███ ", "     ", "     "],
  ".": ["     ", "     ", "     ", "     ", "  █  "],
  _: ["     ", "     ", "     ", "     ", "█████"],
  "?": [" ███ ", "█   █", "  ██ ", "     ", "  █  "],
});

// ---------------------------------------------------------------------------
// visual width — the ONLY width measure (AC2)
// ---------------------------------------------------------------------------

/**
 * Combining marks, zero-width joiners/spaces, bidi controls and variation
 * selectors take no cell at all.
 */
function isZeroWidth(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0xfeff
  );
}

/**
 * The cell that must be counted as ONE even though Unicode's East-Asian Width
 * property calls it *Ambiguous*: box drawing + block elements (U+2500–U+259F,
 * which the banner font is built from). Counting these as two is exactly the
 * bug AC2 pins.
 */
function isAmbiguousOneCell(cp) {
  return cp >= 0x2500 && cp <= 0x259f;
}

/**
 * East-Asian Wide / Fullwidth code points — the ranges a monospace terminal
 * renders two cells wide. Deliberately does NOT contain U+2500–U+259F.
 */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * The visual width of `text` in monospace cells, measured by CODE POINT (so an
 * astral emoji is one iteration, not two) and never by `String.length`.
 */
export function visualWidth(text) {
  if (text === null || text === undefined) return 0;
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (isZeroWidth(cp)) continue;
    // Control characters (incl. \t, \n) contribute no printable cell here.
    if (cp < 0x20 || cp === 0x7f) continue;
    if (isAmbiguousOneCell(cp)) {
      width += 1;
      continue;
    }
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** Pad `text` on the right with spaces up to `width` visual columns. */
export function padVisual(text, width) {
  const value = String(text ?? "");
  const current = visualWidth(value);
  if (current >= width) return value;
  return value + " ".repeat(width - current);
}

/**
 * A prefix of `text` at most `maxWidth` visual columns wide. Never splits a
 * double-width code point in half (the corruption a naive `.slice()` causes).
 */
export function sliceVisual(text, maxWidth) {
  const limit = Math.max(0, Math.floor(Number(maxWidth) || 0));
  let out = "";
  let width = 0;
  for (const ch of String(text ?? "")) {
    const chWidth = visualWidth(ch);
    if (width + chWidth > limit) break;
    out += ch;
    width += chWidth;
  }
  return out;
}

// ---------------------------------------------------------------------------
// rendering (AC1/AC3)
// ---------------------------------------------------------------------------

/** Uppercase and collapse whitespace so a banner is always a single line. */
export function normalizeBannerText(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/\s+/g, " ").trim().toUpperCase();
}

function glyphFor(ch) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, ch) ? GLYPHS[ch] : GLYPHS[FALLBACK_GLYPH];
}

/**
 * Fit one glyph row into a CELL_WIDTH cell. A row that is already exactly the
 * cell width passes through; a shorter one is space-padded using `visualWidth`
 * (never `.length`); a LONGER one is a table bug and fails loud rather than
 * silently clipping (AC2/AC3).
 */
function fitCell(row) {
  const width = visualWidth(row);
  if (width > CELL_WIDTH) {
    throw new RangeError(
      `asciiFont: glyph row ${JSON.stringify(row)} is ${width} cells wide, cell is ${CELL_WIDTH}`,
    );
  }
  return row + " ".repeat(CELL_WIDTH - width);
}

/**
 * Render `text` as exactly BANNER_ROWS strings of equal visual width (AC1).
 * Unknown characters fall back to `?`, so the width never desyncs (AC3).
 */
export function renderBanner(text) {
  const normalized = normalizeBannerText(text);
  const rows = new Array(BANNER_ROWS).fill("");
  if (normalized === "") return rows;
  const chars = [...normalized];
  for (let i = 0; i < chars.length; i += 1) {
    const glyph = glyphFor(chars[i]);
    for (let r = 0; r < BANNER_ROWS; r += 1) {
      rows[r] += fitCell(glyph[r]);
      if (i < chars.length - 1) rows[r] += SEPARATOR;
    }
  }
  return rows;
}

/**
 * Structural validation of the glyph table: five rows per glyph, every row
 * exactly CELL_WIDTH visual columns, and every key a single character. Returns
 * a list of human-readable problems (`[]` means healthy). The module throws on
 * import if the table is corrupt, so a bad edit can never ship quietly.
 */
export function validateGlyphTable() {
  const problems = [];
  for (const [key, rows] of Object.entries(GLYPHS)) {
    if ([...key].length !== 1) problems.push(`glyph key ${JSON.stringify(key)} is not one character`);
    if (!Array.isArray(rows) || rows.length !== BANNER_ROWS) {
      problems.push(`glyph ${key}: expected ${BANNER_ROWS} rows, got ${Array.isArray(rows) ? rows.length : "none"}`);
      continue;
    }
    rows.forEach((row, index) => {
      const width = visualWidth(row);
      if (width !== CELL_WIDTH) {
        problems.push(`glyph ${key} row ${index}: width ${width}, expected ${CELL_WIDTH}`);
      }
    });
  }
  return problems;
}

const TABLE_PROBLEMS = validateGlyphTable();
if (TABLE_PROBLEMS.length > 0) {
  throw new Error(`asciiFont: corrupt glyph table:\n${TABLE_PROBLEMS.join("\n")}`);
}

/** `ON` is exported so a test (and the fallback check) can name the ink cell. */
export { ON as INK };
