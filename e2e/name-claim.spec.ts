// e2e/name-claim.spec.ts — AC3: a name is claimed per room, a duplicate is
// rejected IN REALTIME (case-insensitively) and the UI says why (R7).

import { expect, test } from "@playwright/test";
import {
  claimName,
  connectRoom,
  createRoomViaApi,
  enterRoom,
  expectConnection,
  expectError,
  readRoomFile,
  recordSentFrames,
  uniqueTitle,
} from "./helpers.js";

test("AC3: claim a name; a duplicate held by context A is rejected in context B with a visible reason", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("names") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code);

    // B is in the room but unnamed until it claims.
    await expect(b.page.locator("[data-you-name]")).toHaveText("");
    await expect(b.page.locator("[data-you-session]")).not.toHaveText("");
    // POKER-002 AC5: while unnamed the claim form is the gate.
    await expect(b.page.locator('[data-form="claim"]')).toBeVisible();

    // An empty claim is a clean error, not a crash.
    await claimName(b.page, "");
    await expectError(b.page, "bad_name");

    // A holds "Alice"; B tries the same name in different case.
    for (const attempt of ["Alice", "alice", "ALICE"]) {
      await claimName(b.page, attempt);
      await expectError(b.page, "name_taken");
      await expect(b.page.locator("[data-you-name]")).toHaveText("");
    }

    // The roster still shows A's name (names of members are public; ballots are not).
    await expect(a.page.locator('[data-member][data-member-name="Alice"]')).toHaveCount(1);

    // A free name works, and fans out to A in realtime.
    await claimName(b.page, "Bob");
    await expect(b.page.locator("[data-you-name]")).toHaveText("Bob");
    await expect(a.page.locator('[data-member][data-member-name="Bob"]')).toHaveCount(1);

    // POKER-005: the name is final — the claim form is REMOVED from the DOM, so
    // there is no claim and no rename control in the room (the server refuses a
    // rename too; see the protocol unit tests).
    await expect(b.page.locator('[data-form="claim"]')).toHaveCount(0);
    await expect(b.page.locator('[data-input="name"]')).toHaveCount(0);

    // The claimed name is server-authoritative: it survives a reload.
    await b.page.reload();
    await expectConnection(b.page, "open");
    await expect(b.page.locator("[data-you-name]")).toHaveText("Bob");
    await expect(b.page.locator('[data-form="claim"]')).toHaveCount(0);
    await expect(b.page.locator("[data-error]")).toHaveAttribute("data-error", "");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("POKER-003: a claimed name is burned into the browser and used, never re-claimed", async ({ browser, request }) => {
  const roomA = await createRoomViaApi(request, { title: uniqueTitle("name-life-a") });
  const roomB = await createRoomViaApi(request, { title: uniqueTitle("name-life-b") });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const sent = recordSentFrames(page);

    // First ever visit: nothing stored, so the form is the path.
    await enterRoom(page, roomA.code);
    await expectConnection(page, "open");
    await expect(page.locator('[data-form="claim"]')).toBeVisible();
    await claimName(page, "Lifetime");
    await expect(page.locator("[data-you-name]")).toHaveText("Lifetime");
    expect(await page.evaluate(() => localStorage.getItem("poker.name"))).toBe("Lifetime");

    // Reload the SAME room: the server already knows us, so no claim is sent.
    const beforeReloadA = sent.length;
    await page.reload();
    await expectConnection(page, "open");
    await expect(page.locator("[data-you-name]")).toHaveText("Lifetime");
    await expect(page.locator('[data-form="claim"]')).toHaveCount(0);
    expect(sent.slice(beforeReloadA).filter((frame) => frame.json?.t === "claim")).toEqual([]);

    // A DIFFERENT room: the stored name is claimed silently — form never shown,
    // exactly one claim frame, carrying the stored name.
    const beforeB = sent.length;
    await enterRoom(page, roomB.code);
    await expectConnection(page, "open");
    await expect(page.locator("[data-you-name]")).toHaveText("Lifetime");
    await expect(page.locator('[data-form="claim"]')).toHaveCount(0);
    const claimsInB = sent.slice(beforeB).filter((frame) => frame.json?.t === "claim");
    expect(claimsInB.map((frame) => frame.json?.name)).toEqual(["Lifetime"]);

    // …and the server really has it for this browser's session.
    const file = await readRoomFile(roomB.code);
    const session = await page.evaluate(() => localStorage.getItem("poker.session"));
    expect(file.members.find((member: { session: string }) => member.session === session)?.name).toBe(
      "Lifetime",
    );

    // Reloading B again still sends no claim.
    const beforeReloadB = sent.length;
    await page.reload();
    await expect(page.locator("[data-you-name]")).toHaveText("Lifetime");
    expect(sent.slice(beforeReloadB).filter((frame) => frame.json?.t === "claim")).toEqual([]);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// POKER-006: an unnamed visitor can always claim, and is never a raw UUID
// ---------------------------------------------------------------------------

test("POKER-006: an unnamed member reads 'not named yet', never a raw session id", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("unnamed") });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await enterRoom(page, room.code);
    await expectConnection(page, "open");
    const member = page.locator("[data-member]").first();
    await expect(member).toContainText("not named yet");
    await expect(member).not.toContainText("s-");
  } finally {
    await context.close();
  }
});

test("POKER-006: a stored name this room refuses re-opens the form, prefilled", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("taken") });
  const holderContext = await browser.newContext();
  const context = await browser.newContext();
  try {
    const holder = await holderContext.newPage();
    await enterRoom(holder, room.code);
    await claimName(holder, "Holder");
    await expect(holder.locator("[data-you-name]")).toHaveText("Holder");

    const page = await context.newPage();
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("poker.name", "Holder"));
    await enterRoom(page, room.code);
    await expectError(page, "name_taken");
    await expect(page.locator('[data-form="claim"]')).toBeVisible();
    await expect(page.locator('[data-input="name"]')).toHaveValue("Holder");
  } finally {
    await context.close();
    await holderContext.close();
  }
});

test("POKER-006: a silent claim that never lands still lets you claim", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("stall") });
  const context = await browser.newContext();
  try {
    // Seed the stored name before the app boots, and install the socket route
    // BEFORE the first navigation so the page's WebSocket is intercepted.
    await context.addInitScript(() => localStorage.setItem("poker.name", "Stalled"));
    const page = await context.newPage();
    // Swallow every `claim` the page sends, so the silent auto-claim never lands
    // while hello/hello_ok still flow normally.
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const text = typeof message === "string" ? message : message.toString();
        let json: Record<string, any> | null = null;
        try {
          json = JSON.parse(text) as Record<string, any>;
        } catch {
          json = null;
        }
        if (json?.t === "claim") return; // dropped on the floor
        server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });

    await enterRoom(page, room.code);
    await expectConnection(page, "open");
    // Unnamed and the claim was swallowed → the form appears within the grace.
    await expect(page.locator('[data-form="claim"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-input="name"]')).toHaveValue("Stalled");
  } finally {
    await context.close();
  }
});
