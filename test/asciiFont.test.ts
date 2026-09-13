// test/asciiFont.test.ts — POKER-001e AC1/AC2/AC3: the banner font is generated
// from a table, measured in VISUAL cells (never String.length) and always
// returns five rows of equal width with no clipped glyph cell.
//
// The expected rows below are recomputed from the GLYPHS table independently of
// `renderBanner`'s internals, so a renderer that slices wrongly, clips a cell or
// changes the cell width fails here rather than shipping a desynced banner.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANNER_ROWS,
  CELL_WIDTH,
  FALLBACK_GLYPH,
  GLYPHS,
  padVisual,
  renderBanner,
  sliceVisual,
  validateGlyphTable,
  visualWidth,
} from "../lib/asciiFont.ts";

/** Every character the ticket requires a glyph for (`A–Z 0–9 space - . _`). */
const REQUIRED_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -._";

/** The enumerated banner corpus AC3 names explicitly. */
const ENUMERATED = [
  "POKER",
  "NEW VOTE",
  "REVEAL",
  "MY ROOMS",
  "VOTE HISTORY",
  "CLOSED",
  "WAITING",
  "NO VOTES YET",
  "ABSTAIN",
  "YES",
  "NO",
  "3 2 1",
];

/**
 * An independent oracle: concatenate the table's own rows with one separator
 * column. It intentionally does NOT reuse `renderBanner`, so the test can see a
 * renderer that clips a glyph row or pads by code units.
 */
function expectedRows(text: string): string[] {
  const chars = [...text.toUpperCase()];
  const rows = new Array<string>(BANNER_ROWS).fill("");
  chars.forEach((ch, index) => {
    const glyph = (GLYPHS as Record<string, string[]>)[ch] ?? GLYPHS[FALLBACK_GLYPH];
    for (let r = 0; r < BANNER_ROWS; r += 1) {
      rows[r] += glyph[r];
      if (index < chars.length - 1) rows[r] += " ";
    }
  });
  return rows;
}

test("AC1: the glyph table covers A-Z 0-9 space - . _ and every cell is exactly CELL_WIDTH", () => {
  for (const ch of REQUIRED_GLYPHS) {
    assert.ok(Object.prototype.hasOwnProperty.call(GLYPHS, ch), `missing glyph for ${JSON.stringify(ch)}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(GLYPHS, FALLBACK_GLYPH), "missing fallback glyph");
  assert.equal(Object.keys(GLYPHS).length, REQUIRED_GLYPHS.length + 1, "unexpected extra glyphs in the table");
  assert.deepEqual(validateGlyphTable(), [], "glyph table is structurally corrupt");
});

test("AC1/AC3: renderBanner returns exactly five rows of equal visual width", () => {
  for (const text of ENUMERATED) {
    const rows = renderBanner(text);
    assert.equal(rows.length, BANNER_ROWS, `${text}: expected ${BANNER_ROWS} rows`);
    const widths = rows.map((row) => visualWidth(row));
    assert.equal(new Set(widths).size, 1, `${text}: rows differ in visual width -> ${widths.join(",")}`);
    assert.ok(widths[0] > 0, `${text}: empty banner`);
  }
});

test("AC3: no glyph cell is clipped — the rendered rows equal the table's rows", () => {
  for (const text of ENUMERATED) {
    assert.deepEqual(renderBanner(text), expectedRows(text), `${text}: rendered banner differs from the table`);
  }
  for (const ch of REQUIRED_GLYPHS) {
    // A lone space normalizes away (a blank banner is blank); its cell is
    // checked in context by the corpus above and the "A A" case below.
    if (ch.trim() === "") continue;
    const glyph = (GLYPHS as Record<string, string[]>)[ch];
    const rows = renderBanner(ch);
    assert.equal(rows.length, BANNER_ROWS);
    for (let r = 0; r < BANNER_ROWS; r += 1) {
      // The whole cell survives: nothing was sliced off the end.
      assert.equal(rows[r], padVisual(glyph[r], CELL_WIDTH), `${JSON.stringify(ch)} row ${r} was clipped`);
      assert.equal(visualWidth(rows[r]), CELL_WIDTH);
    }
  }
  // The space cell keeps its full five columns between two glyphs.
  assert.deepEqual(renderBanner("A A"), expectedRows("A A"));
});

test("AC2: box-drawing + block characters (East-Asian Ambiguous) occupy ONE cell", () => {
  // U+2500–U+259F: a wide-char table that calls these two is exactly the bug.
  for (const ch of ["─", "│", "┌", "┐", "█", "▀", "▄", "░", "▒", "▓", "■", "▪"]) {
    assert.equal(visualWidth(ch), 1, `${JSON.stringify(ch)} must be one cell`);
  }
  // …and the banner font is built from them, so the whole row is 5 cells.
  assert.equal(visualWidth("█████"), 5);
  assert.equal(visualWidth("█   █"), 5);
  assert.equal(visualWidth(renderBanner("A")[0]), CELL_WIDTH);
});

test("AC2: width is visual, not String.length (wide + astral code points)", () => {
  assert.equal(visualWidth("字"), 2);
  assert.notEqual(visualWidth("字"), "字".length);
  assert.equal(visualWidth("￥"), 2); // fullwidth form
  assert.equal(visualWidth("😀"), 2); // astral emoji: one iteration, two cells
  assert.equal("😀".length, 2);
  assert.equal(visualWidth("e\u0301"), 1); // combining accent adds no cell
  assert.equal(visualWidth(""), 0);
  assert.equal(padVisual("字", 3), "字 ");
  assert.equal(visualWidth(padVisual("█", 4)), 4);
});

test("AC2: sliceVisual never splits a double-width code point in half", () => {
  assert.equal(sliceVisual("a字b", 3), "a字");
  assert.equal(sliceVisual("a字b", 2), "a");
  assert.equal(sliceVisual("a字b", 1), "a");
  // A naive `"a字b".slice(0, 2)` keeps the 2-cell glyph at a 2-cell budget and
  // reports width 3 — the corruption the helper exists to prevent.
  assert.equal(visualWidth("a字b".slice(0, 2)), 3);
  assert.notEqual(sliceVisual("a字b", 2), "a字b".slice(0, 2));
});

test("AC3: unknown characters degrade to the fallback and never desync the row width", () => {
  const unknown = renderBanner("FRIDAY NIGHT!");
  const fallbackWidth = visualWidth(GLYPHS[FALLBACK_GLYPH][0]);
  const known = renderBanner("FRIDAY NIGHT?");
  assert.deepEqual(unknown, known, "an unknown character must render as the fallback glyph");
  assert.equal(new Set(unknown.map((row) => visualWidth(row))).size, 1);
  assert.equal(visualWidth(unknown[0]), visualWidth(known[0]));
  // Also true for characters the font cannot even name (emoji, CJK, nonsense).
  for (const weird of ["😀😀", "日本語", "abc", "", "   "]) {
    const rows = renderBanner(weird);
    assert.equal(rows.length, BANNER_ROWS);
    assert.equal(new Set(rows.map((row) => visualWidth(row))).size, 1, `${weird}: rows desynced`);
  }
  assert.ok(fallbackWidth > 0);
});
