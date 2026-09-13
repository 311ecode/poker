// e2e/vote-identity.spec.ts — POKER-002 on the real browser:
//   AC1 the deck is the fixed, server-owned planning-poker scale;
//   AC4 my own vote is visible, changeable, and survives a reopen + reload;
//   AC5 an unnamed visitor cannot vote (the name is the gate).
//
// Two independent contexts against ONE real server, like the landed specs.

import { expect, test } from "@playwright/test";
import {
  castVote,
  claimName,
  connectRoom,
  createRoomViaApi,
  openVote,
  uniqueTitle,
  voteCard,
  yourVote,
} from "./helpers.js";

/** POKER-002 AC1: the frozen deck. */
const DECK = ["0", "0.5", "1", "2", "3", "5", "8", "13"];

test("POKER-002 AC1/AC5: the fixed deck is rendered and the name is the gate", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("deck005") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code); // joins unnamed

    // Unnamed: the claim form is the gate, the vote controls are not offered.
    await expect(b.page.locator('[data-form="claim"]')).toBeVisible();
    await expect(b.page.locator('[data-form="open-vote"]')).toBeHidden();
    await expect(b.page.locator("[data-need-name]")).toBeVisible();

    const voteId = await openVote(a.page, "How many points?");
    const card = voteCard(b.page, voteId);
    // POKER-004: exactly the fixed deck, in order, as select options at 0.
    await expect(card.locator("[data-choice-select] option[data-choice]")).toHaveText(
      DECK.map((option) => `${option} (0)`),
    );
    // No name, no ballot: the select is disabled for the unnamed viewer.
    await expect(card.locator("[data-choice-select]")).toBeDisabled();

    // Claiming flips the gate: the deck becomes usable, the form is gone.
    await claimName(b.page, "Bob");
    await expect(b.page.locator('[data-form="claim"]')).toHaveCount(0);
    await expect(b.page.locator('[data-form="open-vote"]')).toBeVisible();
    await expect(b.page.locator("[data-need-name]")).toBeHidden();
    await expect(card.locator("[data-choice-select]")).toBeEnabled();

    await castVote(b.page, voteId, "3");
    await expect(yourVote(b.page, voteId)).toHaveText("3");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("POKER-002 AC4: my vote is obvious, changeable, and survives a reopen + reload", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("ownvote") });
  const context = await browser.newContext();
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });
    const voteId = await openVote(page, "Estimate it");
    const card = voteCard(page, voteId);

    // Before casting, the card says so and the select holds no value.
    await expect(card.locator("[data-your-vote]")).toContainText("not cast yet");
    await expect(card.locator("[data-choice-select]")).toHaveValue("");

    // Cast → the choice is stated in words AND shown by the select.
    await castVote(page, voteId, "3");
    await expect(yourVote(page, voteId)).toHaveText("3");
    await expect(card.locator("[data-choice-select]")).toHaveValue("3");

    // Round 2 is the SAME world: close → reopen keeps my ballot …
    await card.locator('[data-action="close-vote"]').click();
    await expect(card).toHaveAttribute("data-vote-state", "closed");
    await card.locator('[data-action="reopen-vote"]').click();
    await expect(card).toHaveAttribute("data-vote-state", "open");
    await expect(yourVote(page, voteId)).toHaveText("3");

    // … and I can simply change my own choice.
    await castVote(page, voteId, "8");
    await expect(yourVote(page, voteId)).toHaveText("8");
    await expect(card.locator("[data-choice-select]")).toHaveValue("8");
    // The live counts follow the change.
    await expect(card.locator('option[data-choice="3"]')).toHaveAttribute("data-count", "0");
    await expect(card.locator('option[data-choice="8"]')).toHaveAttribute("data-count", "1");

    // The client-side mirror survives a full reload.
    await page.reload();
    await expect(voteCard(page, voteId)).toHaveAttribute("data-vote-state", "open");
    await expect(yourVote(page, voteId)).toHaveText("8");
  } finally {
    await context.close();
  }
});

test("POKER-010: an empty question auto-numbers the vote", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("autovote") });
  const context = await browser.newContext();
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });

    // Open with an empty question → the first vote is titled for us.
    await page.locator('[data-action="open-vote"]').click();
    const first = page.locator("[data-vote]").last();
    await expect(first).toHaveAttribute("data-vote-state", "open");
    await expect(first.locator("[data-vote-title]")).toHaveText("Vote 1");

    // The next one counts on.
    await page.locator('[data-action="open-vote"]').click();
    await expect(page.locator("[data-vote]").last().locator("[data-vote-title]")).toHaveText("Vote 2");

    // A typed question still wins…
    await page.locator('[data-input="vote-title"]').fill("Custom question");
    await page.locator('[data-action="open-vote"]').click();
    await expect(page.locator("[data-vote]").last().locator("[data-vote-title]")).toHaveText(
      "Custom question",
    );
    // …and POKER-012: the box is consumed, ready for the next vote.
    await expect(page.locator('[data-input="vote-title"]')).toHaveValue("");
  } finally {
    await context.close();
  }
});

test("POKER-012: another member's new vote does not clear my typing", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("keepdraft") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    // Alice starts a question but has not opened it yet.
    await a.page.locator('[data-input="vote-title"]').fill("Alice draft");

    // Bob opens one → Alice receives the vote_new broadcast.
    await openVote(b.page, "Bob question");
    await expect(a.page.locator("[data-vote]")).toHaveCount(1);

    // Her draft must survive it.
    await expect(a.page.locator('[data-input="vote-title"]')).toHaveValue("Alice draft");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
