// e2e/presentation.spec.ts — POKER-001e: the dressed screens.
//
// The landed suite asserts protocol/state; this spec asserts the presentation
// contract the same way — behaviour through `data-*` hooks, never rendered
// prose and never the banner's artwork:
//   AC4  every screen has a banner + a defined empty/loading/error state
//   AC5  the open-vote strip is anonymous, ordered, stable and self-last
//   AC7  close → reveal moment (skippable, data immediate); reopen → anonymous
//   AC9  the 480px fallback and no horizontal overflow
//   AC10 measured WCAG contrast ≥ 4.5:1 in BOTH light and dark themes
//   AC11 the rendered banner keeps its grid with the real font stack

import { expect, test, type Page } from "@playwright/test";
import {
  castVote,
  connectRoom,
  createRoomViaApi,
  openVote,
  uniqueTitle,
  voteCard,
  voterOrder,
} from "./helpers.js";

const MOBILE_BREAKPOINT = 480;

// ---------------------------------------------------------------------------
// AC4 + AC1 delivery: every screen has a generated banner and defined states
// ---------------------------------------------------------------------------

test("AC4: every screen carries a generated banner and a defined empty/loading/error state", async ({ page, request }) => {
  // The font module is delivered to the browser as plain ES (no build step).
  const fontResponse = await request.get("/asciiFont.js");
  expect(fontResponse.status()).toBe(200);
  expect(fontResponse.headers()["content-type"]).toContain("text/javascript");
  expect(await fontResponse.text()).toContain("renderBanner");

  await page.goto("/");

  // Landing: the brand banner, generated from the table and wired to the DOM.
  const brand = page.locator("header [data-banner]").first();
  await expect(brand).toHaveAttribute("data-banner-text", "POKER");
  const art = (await brand.locator("[data-banner-pre]").textContent()) ?? "";
  expect(art.split("\n")).toHaveLength(5);
  expect(art.trim()).not.toBe("");
  await expect(brand.locator("[data-banner-compact]")).toHaveText("POKER");
  // Three visible banners on Home: brand + ROOMS + MY ROOMS.
  await expect(page.locator("[data-banner]:visible")).toHaveCount(3);

  // Home: defined rooms (idle) and my-rooms (empty) states.
  await expect(page.locator("[data-rooms]")).toHaveAttribute("data-rooms-state", "idle");
  await expect(page.locator("[data-my-rooms]")).toHaveAttribute("data-my-rooms-state", "empty");
  await expect(page.locator('[data-empty="my-rooms"]')).toBeVisible();

  // Find rooms → a defined (empty here) result state, not a blank screen.
  await page.locator('[data-action="find-rooms"]').click();
  await expect(page.locator("[data-rooms]")).toHaveAttribute("data-rooms-state", /ready|empty/);

  // Room with no vote → banner + defined empty votes state.
  const room = await createRoomViaApi(request, { title: uniqueTitle("present") });
  await page.goto(`/#/room/${room.code}`);
  await expect(page.locator("[data-panel='room']")).toBeVisible();
  await expect(page.locator("[data-room-banner]")).toHaveAttribute("data-banner-text", room.title);
  await expect(page.locator("[data-votes]")).toHaveAttribute("data-votes-state", "empty");
  await expect(page.locator('[data-empty="votes"]')).toBeVisible();
  await expect(page.locator("[data-history]")).toHaveAttribute("data-history-state", "idle");
  await expect(page.locator('[data-empty="history"]')).toBeVisible();

  // History: a defined loading/empty state after the request.
  await page.locator('[data-action="load-history"]').click();
  await expect(page.locator("[data-history]")).toHaveAttribute("data-history-state", /ready|empty/);

  // Error state: an unknown room surfaces the alert, not a broken screen.
  await page.goto("/#/room/ZZZZZZ");
  await expect(page.locator("[data-error]")).toHaveAttribute("data-error", "bad_room");
  await expect(page.locator("[data-error]")).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC5 + AC7: anonymous strip, reveal moment, reopen
// ---------------------------------------------------------------------------

test("AC5/AC7: the open strip is anonymous and ordered; close reveals; reopen re-hides", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("reveal-ui") });
  // Force no-preference so the reveal animation is deterministic in the test.
  const contextA = await browser.newContext();
  const contextB = await browser.newContext({ reducedMotion: "no-preference" });
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    const voteId = await openVote(a.page, "Who pays the tab?", ["Heads", "Tails"]);
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "open");

    // AC5: one nameless row per member, self last, marked as you.
    const rows = voteCard(b.page, voteId).locator("[data-voter]");
    await expect(rows).toHaveCount(2);
    await expect(voteCard(b.page, voteId).locator('[data-voter][data-voter-nameless="true"]')).toHaveCount(2);
    const orderBefore = await voterOrder(b.page, voteId);
    const flags = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-voter-self")));
    expect(flags).toEqual(["false", "true"]);
    expect(orderBefore[orderBefore.length - 1]).toBe(
      await voteCard(b.page, voteId).locator('[data-voter][data-voter-self="true"]').getAttribute("data-voter-session"),
    );
    // No member name anywhere on the open card (R1/R2).
    await expect(voteCard(b.page, voteId)).not.toContainText("Alice");
    await expect(voteCard(b.page, voteId)).not.toContainText("Bob");

    // AC6: the tally is a real "N of M voted" progress, updated live.
    await castVote(a.page, voteId, "Heads");
    await castVote(b.page, voteId, "Tails");
    await expect(voteCard(b.page, voteId).locator("[data-voted-count]")).toHaveText("2");
    await expect(voteCard(b.page, voteId).locator("[data-total-members]")).toHaveText("2");
    await expect(voteCard(b.page, voteId).locator("[data-progress-fill]")).toHaveAttribute("style", /width:\s*100%/);

    // A re-render (another cast) must not reorder the strip (AC5 stability).
    await castVote(a.page, voteId, "Heads");
    expect(await voterOrder(b.page, voteId)).toEqual(orderBefore);

    // AC7: close → the reveal moment, per-option bars, the named list.
    await voteCard(a.page, voteId).locator('[data-action="close-vote"]').click();
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "closed");
    const reveal = voteCard(b.page, voteId).locator("[data-reveal]");
    await expect(reveal).toHaveCount(1);
    // The data is present immediately — the animation is presentation only.
    await expect(reveal.locator("[data-reveal-banner]")).toHaveAttribute("data-banner-text", "REVEAL");
    await expect(voteCard(b.page, voteId).locator('[data-reveal-entry][data-reveal-name="Alice"]')).toHaveCount(1);
    await expect(voteCard(b.page, voteId).locator('[data-reveal-entry][data-reveal-name="Bob"]')).toHaveCount(1);
    await expect(voteCard(b.page, voteId).locator("[data-result-bar]")).toHaveCount(2);
    await expect(
      voteCard(b.page, voteId).locator('[data-result-bar][data-result-option="Heads"]'),
    ).toHaveAttribute("data-result-count", "1");

    // AC7: the animation is skippable and skipping does not hide the data.
    await expect(reveal).toHaveAttribute("data-reveal-animation", "on");
    await reveal.locator('[data-action="skip-reveal"]').click();
    await expect(reveal).toHaveAttribute("data-reveal-animation", "skipped");
    await expect(voteCard(b.page, voteId).locator("[data-reveal-entry]")).toHaveCount(2);

    // R6/AC7: reopen returns both contexts to the anonymous state.
    await voteCard(b.page, voteId).locator('[data-action="reopen-vote"]').click();
    await expect(voteCard(a.page, voteId)).toHaveAttribute("data-vote-state", "open");
    await expect(voteCard(a.page, voteId).locator("[data-reveal]")).toHaveCount(0);
    await expect(voteCard(a.page, voteId).locator("[data-voter]")).toHaveCount(2);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

// ---------------------------------------------------------------------------
// AC8: history shows final results/events for closed, counts only for open
// ---------------------------------------------------------------------------

test("AC8: history marks closed votes with the final result and keeps the events", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("history-ui") });
  const context = await browser.newContext();
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });
    const voteId = await openVote(page, "History me", ["Yes", "No"]);
    await castVote(page, voteId, "Yes");
    await voteCard(page, voteId).locator('[data-action="close-vote"]').click();
    await expect(voteCard(page, voteId)).toHaveAttribute("data-vote-state", "closed");

    await page.locator('[data-action="load-history"]').click();
    const entry = page.locator(`[data-history-vote][data-history-vote-id="${voteId}"]`);
    await expect(entry).toHaveAttribute("data-history-state", "closed");
    await expect(entry).toHaveAttribute("data-history-final", "true");
    await expect(entry.locator('[data-history-reveal-entry][data-reveal-name="Alice"]')).toHaveCount(1);
    await expect
      .poll(() =>
        entry.locator("[data-history-event]").evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-event-kind")),
        ),
      )
      .toEqual(["opened", "closed"]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// AC11: the rendered banner keeps its grid with the real font stack
// ---------------------------------------------------------------------------

test("AC11: every row of the rendered banner is the same width (monospace fallback)", async ({ page }) => {
  await page.goto("/");
  const widths = await page.locator("header [data-banner-pre]").evaluate((pre) => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    // One rect per line box; the zero-width rects are the newline boundaries.
    return [...range.getClientRects()]
      .filter((rect) => rect.width > 0)
      .map((rect) => Math.round(rect.width * 100) / 100);
  });
  expect(widths).toHaveLength(5);
  for (const width of widths) {
    expect(Math.abs(width - widths[0])).toBeLessThanOrEqual(0.5);
  }
});

// ---------------------------------------------------------------------------
// AC9: mobile fallback, documented breakpoint, no horizontal overflow
// ---------------------------------------------------------------------------

test("AC9: below 480px the compact banner replaces the block art and nothing overflows", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("mobile") });
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const page = await context.newPage();
    await page.goto("/");

    const brand = page.locator("header [data-banner]").first();
    expect(MOBILE_BREAKPOINT).toBe(480);
    await expect(brand).toHaveAttribute("data-banner-mode", "compact");
    await expect(brand.locator("[data-banner-pre]")).toBeHidden();
    await expect(brand.locator("[data-banner-compact]")).toBeVisible();
    await expect(brand.locator("[data-banner-compact]")).toHaveText("POKER");

    // A room with an open vote is the widest screen; still no overflow.
    await page.goto(`/#/room/${room.code}`);
    await expect(page.locator("[data-panel='room']")).toBeVisible();
    await expect(page.locator("[data-room-banner]")).toHaveAttribute("data-banner-mode", "compact");
    await expect(page.locator("[data-room-banner] [data-banner-pre]")).toBeHidden();

    const measured = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(measured.docScroll).toBe(measured.docClient);
    expect(measured.bodyScroll).toBeLessThanOrEqual(measured.docClient);

    // The narrowest common phone width stays safe too.
    await page.setViewportSize({ width: 320, height: 568 });
    const tiny = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
    }));
    expect(tiny.docScroll).toBe(tiny.docClient);

    // Desktop keeps the block banner.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("[data-room-banner]")).toHaveAttribute("data-banner-mode", "full");
    await expect(page.locator("[data-room-banner] [data-banner-pre]")).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// AC10: measured contrast in BOTH themes (DASH-138: never eyeball light mode)
// ---------------------------------------------------------------------------

interface ContrastPair {
  name: string;
  ratio: number;
  a: string;
  b: string;
}

/** Measure the real computed theme tokens and the WCAG ratio of each pair. */
async function measureTheme(page: Page): Promise<ContrastPair[]> {
  return page.evaluate(() => {
    const toRgb = (value: string): string => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    };
    const channel = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = (rgb: string): number => {
      const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: string, b: string): number => {
      const l1 = luminance(a);
      const l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const style = getComputedStyle(document.documentElement);
    const token = (name: string): string => toRgb(style.getPropertyValue(name).trim());
    const pairs: [string, string, string][] = [
      ["text/bg", "--text", "--bg"],
      ["text/panel", "--text", "--panel"],
      ["muted/bg", "--muted", "--bg"],
      ["muted/panel", "--muted", "--panel"],
      ["ink(banner)/bg", "--ink", "--bg"],
      ["accent/bg", "--accent", "--bg"],
      ["button text/accent", "--accent-contrast", "--accent"],
      ["alert text/alert bg", "--alert-text", "--alert-bg"],
      ["alert text/panel", "--alert-text", "--panel"],
      ["ok(status)/panel", "--ok", "--panel"],
    ];
    return pairs.map(([name, fg, bg]) => {
      const a = token(fg);
      const b = token(bg);
      return { name, a, b, ratio: Math.round(ratio(a, b) * 100) / 100 };
    });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`AC10: ${scheme} theme text contrast is at least 4.5:1 (measured)`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const pairs = await measureTheme(page);
      // The tokens are actually applied to the rendered page, not just declared.
      const applied = await page.evaluate(() => ({
        color: getComputedStyle(document.body).color,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      expect(applied.color).toBe(pairs[0].a);
      expect(applied.background).toBe(pairs[0].b);
      console.log(`AC10 ${scheme} contrast ratios: ${pairs.map((p) => `${p.name}=${p.ratio}`).join("  ")}`);
      for (const pair of pairs) {
        expect(pair.ratio, `${scheme} ${pair.name} (${pair.a} on ${pair.b})`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await context.close();
    }
  });
}
