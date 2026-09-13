// e2e/my-rooms.spec.ts — My Rooms is CLIENT-ONLY localStorage state
// (POKER-001c AC5, parent §1.7): most-recent-first, updated on every visit,
// survives a reload, and the server holds no per-browser history at all.

import { expect, test } from "@playwright/test";
import {
  createRoomViaApi,
  enterRoom,
  expectConnection,
  goHome,
  joinViaForm,
  readRoomFile,
  uniqueTitle,
} from "./helpers.js";

test("AC5: My Rooms is per-browser, most-recent-first, survives reload, and never reaches the server", async ({ browser, request }) => {
  const roomA = await createRoomViaApi(request, { title: uniqueTitle("visited-a") });
  const roomB = await createRoomViaApi(request, { title: uniqueTitle("visited-b") });

  const context = await browser.newContext();
  const other = await browser.newContext();
  try {
    const app = await context.newPage();

    // Visit room A.
    await enterRoom(app, roomA.code);
    await expectConnection(app, "open");

    // The frozen key, verbatim (§1.7), holding exactly room A.
    const afterA = await app.evaluate(() => JSON.parse(localStorage.getItem("poker.myrooms") ?? "[]"));
    expect(afterA.map((entry: { code: string }) => entry.code)).toEqual([roomA.code]);
    expect(typeof afterA[0].lastVisitAt).toBe("number");

    // Home renders it as a first-class row.
    await goHome(app);
    await expect(app.locator(`[data-my-room][data-my-room-code="${roomA.code}"]`)).toHaveCount(1);

    // Visit room B → most-recent-first flips.
    await joinViaForm(app, roomB.code);
    await goHome(app);
    const orderDom = await app
      .locator("[data-my-room]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-my-room-code")));
    expect(orderDom).toEqual([roomB.code, roomA.code]);

    const afterB = await app.evaluate(() => JSON.parse(localStorage.getItem("poker.myrooms") ?? "[]"));
    expect(afterB.map((entry: { code: string }) => entry.code)).toEqual([roomB.code, roomA.code]);
    expect(afterB[0].lastVisitAt).toBeGreaterThanOrEqual(afterB[1].lastVisitAt);

    // Visiting A again moves it back to the front without duplicating.
    await joinViaForm(app, roomA.code);
    await goHome(app);
    const revisited = await app.evaluate(() => JSON.parse(localStorage.getItem("poker.myrooms") ?? "[]"));
    expect(revisited.map((entry: { code: string }) => entry.code)).toEqual([roomA.code, roomB.code]);
    expect(new Set(revisited.map((entry: { code: string }) => entry.code)).size).toBe(2);

    // Survives a full reload, and the session identity is stable.
    const sessionBefore = await app.evaluate(() => localStorage.getItem("poker.session"));
    expect(sessionBefore).toMatch(/^s-/);
    await app.reload();
    await expect(app.locator('[data-panel="home"]')).toBeVisible();
    const survived = await app.evaluate(() => JSON.parse(localStorage.getItem("poker.myrooms") ?? "[]"));
    expect(survived.map((entry: { code: string }) => entry.code)).toEqual([roomA.code, roomB.code]);
    const sessionAfter = await app.evaluate(() => localStorage.getItem("poker.session"));
    expect(sessionAfter).toBe(sessionBefore);
    await expect(app.locator(`[data-my-room][data-my-room-code="${roomA.code}"]`)).toHaveCount(1);

    // A different browser context has its own, empty My Rooms.
    const otherPage = await other.newPage();
    await otherPage.goto("/");
    await expect(otherPage.locator("[data-my-room]")).toHaveCount(0);
    const otherStore = await otherPage.evaluate(() => localStorage.getItem("poker.myrooms"));
    expect(otherStore).toBeNull();

    // --- the server holds NO per-browser history -------------------------
    // (a) there is no such endpoint…
    expect((await request.get("/api/myrooms")).status()).toBe(404);
    expect((await request.get(`/api/rooms/${roomA.code}/myrooms`)).status()).toBe(404);
    // (b) health carries no per-browser data…
    const health = JSON.stringify(await (await request.get("/api/health")).json());
    expect(health.toLowerCase()).not.toContain("myroom");
    // (c) …and the room file on disk has no visits/browsers/myrooms keys.
    const file = await readRoomFile(roomA.code);
    expect(Object.keys(file)).not.toContain("myrooms");
    expect(Object.keys(file)).not.toContain("visits");
    expect(Object.keys(file)).not.toContain("browsers");
    expect(JSON.stringify(file).toLowerCase()).not.toContain("myroom");
    // The file we read is really room A's (it lists this browser's session).
    expect(file.members.map((member: { session: string }) => member.session)).toContain(sessionBefore);

    // (d) history is votes only — never a browser/visit list.
    const history = (await (await request.get(`/api/rooms/${roomA.code}/history`)).json()) as Record<string, unknown>;
    expect(Object.keys(history)).toEqual(["votes"]);
  } finally {
    await context.close();
    await other.close();
  }
});
