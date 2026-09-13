// e2e/anonymity.spec.ts — R1/R2 asserted against the REAL WEBSOCKET WIRE
// (POKER-001c AC7, parent §4.1.2). Context B's frames come from Playwright's
// native `page.on("websocket")` / `framereceived`, not from the DOM and not
// from a mocked socket. The `public/leakguard.js` scanner used here is the same
// pure module that `test/leakguard.test.ts` deliberately falsifies with a
// synthetic leaking frame.

import { expect, test } from "@playwright/test";
import { openVoteViolationsInFrames, revealKeysInFrames } from "../public/leakguard.js";
import {
  castVote,
  connectRoom,
  createRoomViaApi,
  framesSince,
  openVote,
  uniqueTitle,
  voteCard,
} from "./helpers.js";

test("AC7: while a vote is open context B receives counts only — no name/reveal/ballots/choice", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("anonymity") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code, { name: "Bob" });

    const voteId = await openVote(a.page, "Who pays the tab?");
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "open");

    // Record ONLY what context B receives while the vote is open: B changes its
    // ballot, then A casts.
    const mark = b.frames.length;
    await castVote(b.page, voteId, "5");
    await castVote(a.page, voteId, "3");
    await expect(voteCard(b.page, voteId).locator("[data-voted-count]")).toHaveText("2");

    const openFrames = framesSince(b.frames, mark);
    expect(openFrames.length).toBeGreaterThan(0);

    // (1) The frames really are the open-vote updates we think they are.
    const decoded = openFrames.map((payload) => JSON.parse(payload) as Record<string, any>);
    const updates = decoded.filter((message) => message.t === "vote_update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.every((message) => message.vote.state === "open")).toBe(true);

    // (2) No frame received while open contains reveal/ballots ANYWHERE.
    expect(revealKeysInFrames(openFrames)).toEqual([]);

    // (3) Every open-vote frame uses exactly the permit-listed keys — counts,
    //     votedCount, totalMembers and the vote's own metadata. No names.
    const violations = openVoteViolationsInFrames(openFrames);
    expect(violations).toEqual([]);

    // (4) Belt and braces: no raw frame even mentions the member names or a
    //     per-person choice payload (`choice` inside a ballot is the leak).
    for (const payload of openFrames) {
      expect(payload).not.toContain("Alice");
      expect(payload).not.toContain("Bob");
      expect(payload).not.toContain('"ballots"');
      expect(payload).not.toContain('"reveal"');
    }

    // (5) The DOM agrees: while open, the vote card carries no member name.
    const cardInB = voteCard(b.page, voteId);
    await expect(cardInB).not.toContainText("Alice");
    await expect(cardInB).not.toContainText("Bob");

    // (5b) Supplement (never a replacement): the client's own leak scanner saw
    //      nothing either.
    expect(await b.page.evaluate(() => (globalThis as any).__pokerLeaks)).toEqual([]);

    // (6) Positive control: after close the wire DOES carry reveal, so (2)-(4)
    //     are a real absence and not an empty capture.
    await voteCard(a.page, voteId).locator('[data-action="close-vote"]').click();
    await expect(voteCard(b.page, voteId)).toHaveAttribute("data-vote-state", "closed");
    const closedFrames = framesSince(b.frames, mark)
      .map((payload) => JSON.parse(payload) as Record<string, any>)
      .filter((message) => message.t === "vote_closed");
    expect(closedFrames.length).toBeGreaterThan(0);
    expect(closedFrames[closedFrames.length - 1]!.vote.reveal).toEqual(
      expect.arrayContaining([
        { name: "Alice", choice: "3" },
        { name: "Bob", choice: "5" },
      ]),
    );
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
