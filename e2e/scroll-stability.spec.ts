// e2e/scroll-stability.spec.ts — POKER-011: the Open-a-vote form sits BELOW the
// vote list, and casting a vote never moves the page or steals focus from the
// control the user is working in.

import { expect, test } from "@playwright/test";
import {
  connectRoom,
  createRoomViaApi,
  openVote,
  uniqueTitle,
  voteCard,
  yourVote,
} from "./helpers.js";

test("POKER-011: the Open-a-vote form comes after the votes", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("formbelow") });
  const context = await browser.newContext();
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });
    const order = await page.evaluate(() => {
      const votes = document.querySelector("[data-votes]");
      const form = document.querySelector('[data-form="open-vote"]');
      if (!votes || !form) return "missing";
      const follows =
        (votes.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return follows ? "after" : "before";
    });
    expect(order).toBe("after");
  } finally {
    await context.close();
  }
});

test("POKER-011: voting from a scrolled position does not jump or lose focus", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("noscroll") });
  // A short viewport makes the room long enough that a jump would be obvious.
  const context = await browser.newContext({ viewport: { width: 900, height: 380 } });
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });
    for (let i = 0; i < 6; i += 1) await openVote(page, `Question ${i}`);
    const voteId = await openVote(page, "The last one");
    const card = voteCard(page, voteId);

    await card.scrollIntoViewIfNeeded();
    const select = card.locator("[data-choice-select]");
    await select.focus();
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    await select.selectOption("3");
    await expect(yourVote(page, voteId)).toHaveText("3");
    // Let both rebuilds settle: the optimistic render and the server echo.
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    await expect(select).toBeFocused();
  } finally {
    await context.close();
  }
});
