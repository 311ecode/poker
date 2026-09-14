// e2e/scroll-stability.spec.ts — POKER-011: the Open-a-vote form sits BELOW the
// vote list, and casting a vote never moves the page or steals focus from the
// control the user is working in.
//
// POKER-016: `renderVotes()` rebuilds EVERY card node (`replaceChildren`), and a
// render happens on the optimistic update, the server echo and any broadcast.
// `openVote()` returns on the optimistic render, so a later frame can detach the
// node Playwright just resolved — that was a ~17% full-suite flake on
// `scrollIntoViewIfNeeded`. Locators are lazy, so the interactions below retry
// and re-resolve. Forcing that same rebuild deterministically (last test) then
// exposed a genuine bug: a concurrent vote scrolled the page, because browser
// scroll anchoring undid `renderVotes()`' restore one frame later.

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

    // POKER-016: a rebuild between `openVote`'s optimistic render and this step
    // detaches the node. Retry the whole step — the lazy locators re-resolve.
    await expect(async () => {
      await card.scrollIntoViewIfNeeded();
      await card.locator("[data-choice-select]").focus();
    }).toPass();
    const select = card.locator("[data-choice-select]");
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    // The cast races the same rebuild; retrying is safe (same value, no-op change).
    await expect(async () => {
      await select.selectOption("3");
    }).toPass();
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

/**
 * POKER-016: the same guarantee as above, but the rebuild is FORCED instead of
 * awaited by luck. While Alice has scrolled to a card and focused its select,
 * Bob (a second member) opens a vote. That broadcast makes Alice's client call
 * `renderVotes()` → `replaceChildren()`, which detaches the very node she is
 * working in — the race the flake above kept losing.
 *
 * This test failed before the fix, and for a REAL reason: `renderVotes()`
 * restores `scrollTop` synchronously, but browser scroll anchoring (anchored to
 * the content below the grown list) shifted the viewport ~27px a frame LATER.
 * `html { overflow-anchor: none }` in `public/style.css` stops the browser from
 * fighting the app's own scroll preservation, and this test is the regression
 * guard for it.
 */
test("POKER-016: a concurrent broadcast mid-interaction keeps scroll and focus", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("rebuild") });
  const aliceContext = await browser.newContext({ viewport: { width: 900, height: 380 } });
  const bobContext = await browser.newContext();
  try {
    const { page } = await connectRoom(aliceContext, room.code, { name: "Alice" });
    for (let i = 0; i < 6; i += 1) await openVote(page, `Question ${i}`);
    const voteId = await openVote(page, "The last one");

    const card = voteCard(page, voteId);
    await expect(async () => {
      await card.scrollIntoViewIfNeeded();
      await card.locator("[data-choice-select]").focus();
    }).toPass();
    const select = card.locator("[data-choice-select]");
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await expect(select).toBeFocused();

    // The forced rebuild: Bob's vote lands on Alice's page as `vote_new`.
    const bob = await connectRoom(bobContext, room.code, { name: "Bob" });
    await openVote(bob.page, "Bob's question");
    // Alice must have painted it — that is the `renderVotes()` that detaches `select`.
    await expect(page.locator("[data-vote]")).toHaveCount(8);
    // The anchoring shift lands a frame AFTER the rebuild, so sample only once
    // the layout has settled — otherwise this could pass by racing the bug.
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    await expect(select).toBeFocused();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
