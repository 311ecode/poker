// e2e/vote-realtime.spec.ts — realtime fan-out (AC6), per-viewer ordering
// (AC8) and close → reveal → reopen → history (AC9). Every test uses TWO
// independent `browser.newContext()` contexts against ONE real server
// (parent §4.1: no mocked sockets, no single-page simulation).

import { expect, test } from "@playwright/test";
import {
  castVote,
  connectRoom,
  createRoomViaApi,
  framesSince,
  openVote,
  uniqueTitle,
  voteCard,
  voterOrder,
  expectConnection,
} from "./helpers.js";

test("AC6: a vote opened in context A is pushed to context B without a reload", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("fanout") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    const navigationsBefore = b.navigations();
    const mark = b.frames.length;
    const voteId = await openVote(a.page, "Who pays?");

    // (a) the DOM in B changes with no navigation/reload…
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "open");
    expect(b.navigations()).toBe(navigationsBefore);

    // (b) …driven by a real `vote_new` frame on B's wire.
    const openFrames = framesSince(b.frames, mark);
    const voteNew = openFrames.map((payload) => JSON.parse(payload)).filter((message) => message.t === "vote_new");
    expect(voteNew.length).toBeGreaterThan(0);
    expect(voteNew[0].vote.id).toBe(voteId);
    // POKER-002 AC1: the fixed deck, server-owned.
    expect(voteNew[0].vote.options).toEqual(["0", "0.5", "1", "2", "3", "5", "8", "13"]);
    expect(voteNew[0].vote.counts).toEqual({
      "0": 0,
      "0.5": 0,
      "1": 0,
      "2": 0,
      "3": 0,
      "5": 0,
      "8": 0,
      "13": 0,
    });
    expect(voteNew[0].vote.votedCount).toBe(0);
    expect(voteNew[0].vote.reveal).toBeUndefined();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("AC8: voter order is per-viewer, stable across a reload and self is last (R3/R4)", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("order") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    const voteId = await openVote(a.page, "Ordering?");
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "open");

    const orderA = await voterOrder(a.page, voteId);
    const orderB = await voterOrder(b.page, voteId);
    expect(orderA).toHaveLength(2);
    expect(orderB).toHaveLength(2);
    // Same members, different per-viewer order (R3).
    expect([...orderA].sort()).toEqual([...orderB].sort());
    expect(orderA).not.toEqual(orderB);

    // Self is always LAST (R4), and exactly one slot is self.
    const flagsA = await voteCard(a.page, voteId)
      .locator("[data-voter]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-voter-self")));
    expect(flagsA).toEqual(["false", "true"]);
    const selfA = await voteCard(a.page, voteId)
      .locator('[data-voter][data-voter-self="true"]')
      .getAttribute("data-voter-session");
    expect(orderA[orderA.length - 1]).toBe(selfA);

    const selfB = await voteCard(b.page, voteId)
      .locator('[data-voter][data-voter-self="true"]')
      .getAttribute("data-voter-session");
    expect(orderB[orderB.length - 1]).toBe(selfB);
    expect(selfA).not.toBe(selfB);

    // Stable across a full reload / fresh hello (R4).
    await a.page.reload();
    await expectConnection(a.page, "open");
    await expect(voteCard(a.page, voteId)).toHaveAttribute("data-vote-state", "open");
    await expect.poll(() => voterOrder(a.page, voteId)).toEqual(orderA);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("AC9: close reveals names+choices, reopen re-hides and resumes, history keeps the events (R5/R6)", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("reveal") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    const voteId = await openVote(a.page, "Reveal me");
    await castVote(a.page, voteId, "3");
    await castVote(b.page, voteId, "5");
    await expect(voteCard(b.page, voteId).locator("[data-voted-count]")).toHaveText("2");
    // While open there is no reveal anywhere.
    await expect(voteCard(b.page, voteId).locator("[data-reveal]")).toHaveCount(0);

    // Close (from A) → everyone sees names + choices.
    await voteCard(a.page, voteId).locator('[data-action="close-vote"]').click();
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "closed");
    await expect(
      voteCard(b.page, voteId).locator('[data-reveal-entry][data-reveal-name="Alice"][data-reveal-choice="3"]'),
    ).toHaveCount(1);
    await expect(
      voteCard(b.page, voteId).locator('[data-reveal-entry][data-reveal-name="Bob"][data-reveal-choice="5"]'),
    ).toHaveCount(1);

    // Reopen (from B) → names hidden again, same vote, voting resumes.
    await voteCard(b.page, voteId).locator('[data-action="reopen-vote"]').click();
    await expect(voteCard(a.page, voteId)).toHaveAttribute("data-vote-state", "open");
    await expect(voteCard(a.page, voteId).locator("[data-reveal]")).toHaveCount(0);
    await castVote(a.page, voteId, "5");
    await expect(voteCard(b.page, voteId).locator('option[data-choice="5"]')).toHaveAttribute("data-count", "2");
    await expect(voteCard(b.page, voteId).locator("[data-voted-count]")).toHaveText("2");

    // History: one vote, all three transitions, in order.
    await a.page.locator('[data-action="load-history"]').click();
    const history = a.page.locator(`[data-history-vote][data-history-vote-id="${voteId}"]`);
    await expect(history).toHaveAttribute("data-history-state", "open");
    await expect
      .poll(() =>
        history
          .locator("[data-history-event]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event-kind"))),
      )
      .toEqual(["opened", "closed", "reopened"]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
