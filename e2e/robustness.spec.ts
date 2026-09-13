// e2e/robustness.spec.ts — AC10: hostile input on the real socket and a bad
// JSON HTTP body must not break the page; the connection recovers.

import { expect, test, type Page } from "@playwright/test";
import {
  connectRoom,
  createRoomViaApi,
  expectConnection,
  expectError,
  openVote,
  uniqueTitle,
  voteCard,
} from "./helpers.js";

/** Put a raw payload on the page's real WebSocket through the debug hook. */
function sendRaw(page: Page, payload: string): Promise<boolean> {
  return page.evaluate((text) => (globalThis as any).__pokerTest.sendRaw(text), payload);
}

test("AC10: malformed + oversize WS payload and a bad JSON body do not break the page", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("robust") });
  const context = await browser.newContext();
  try {
    const { page } = await connectRoom(context, room.code, { name: "Alice" });

    // 1) malformed JSON on the wire → error UI, socket survives.
    expect(await sendRaw(page, "{ this is not json")).toBe(true);
    await expectError(page, "bad_message");
    await expectConnection(page, "open");

    // 2) oversize payload (70 KiB > the 64 KiB ceiling) → discarded, reported,
    //    socket survives.
    expect(await sendRaw(page, "x".repeat(70 * 1024))).toBe(true);
    await expect(page.locator("[data-error]")).toHaveAttribute("data-error", "bad_message");
    await expectConnection(page, "open");

    // 3) a bad JSON body to the HTTP API is a 400, and the page is unaffected.
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
      });
      return response.status;
    });
    expect(status).toBe(400);

    // 4) the page still does real work after the abuse.
    const voteId = await openVote(page, "Still alive");
    await expect(voteCard(page, voteId)).toHaveAttribute("data-vote-state", "open");

    // 5) a dropped socket reconnects, re-hellos the same room and keeps the name.
    await page.evaluate(() => (globalThis as any).__pokerTest.closeSocket());
    await page.waitForFunction(
      () => document.querySelector("[data-connection]")?.getAttribute("data-connection") === "closed",
    );
    await expectConnection(page, "open");
    await expect(page.locator("[data-room-code]")).toHaveText(room.code);
    await expect(page.locator("[data-you-name]")).toHaveText("Alice");
    await expect(voteCard(page, voteId)).toHaveAttribute("data-vote-state", "open");
  } finally {
    await context.close();
  }
});
