// e2e/connection-indicator.spec.ts — POKER-015.
//
// The header connection line reports the ROOM socket, so it is hidden outside a
// room. Two false states are pinned here, both confirmed in a browser before the
// fix:
//   1. a fresh `/` shouted a red "connection: closed" for a socket it never
//      opens (`connect()` early-returns without a room);
//   2. leaving a room left a stale green "connection: open" behind, because
//      `applyRoute()` called `closeSocket()` but never `setConnection(...)` and
//      `closeSocket()` nulls `socket` before closing, so the socket's own
//      `close` handler bailed out (`if (socket !== ws) return`).
//
// AC4 guards the REAL signal: while in a room, a genuine drop must still be
// visible and must still recover — hiding the line must not hide the problem.

import { expect, test, type Page } from "@playwright/test";
import { createRoomViaApi, enterRoom, expectConnection, goHome, uniqueTitle } from "./helpers.js";

/** The connection line itself (`<p>`), not the `[data-connection]` value span. */
const line = (page: Page) => page.locator("[data-connection-line]");

test("POKER-015 AC1: home hides the connection line; the hook stays closed", async ({ page, request }) => {
  // No first-paint flash: the markup must ship the line hidden, so a slow
  // app.js cannot show a red "closed" on the landing page before it runs.
  const html = await (await request.get("/")).text();
  expect(html).toMatch(/<p[^>]*data-connection-line[^>]*\shidden[\s>]/);

  await page.goto("/");
  await expect(page.locator('[data-panel="home"]')).toBeVisible();
  // The attribute hook survives — only the lie is gone.
  await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "closed");
  await expect(line(page)).toBeHidden();
});

test("POKER-015 AC2: in a room the line is visible and opens", async ({ page, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("conn-open") });
  await enterRoom(page, room.code);

  // Visible from the moment the room renders — before the socket is even open.
  await expect(line(page)).toBeVisible();
  await expectConnection(page, "open");
  await expect(line(page)).toHaveText(/open/);
});

test("POKER-015 AC3: leaving a room hides the line — no stale green open", async ({ page, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("conn-leave") });
  await enterRoom(page, room.code);
  await expectConnection(page, "open");

  await goHome(page);
  await expect(line(page)).toBeHidden();
  // Honour the state too: nothing downstream may read a stale "open".
  await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "closed");
});

test("POKER-015 AC4: a genuine in-room drop is still visible and recovers", async ({ page, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("conn-drop") });
  await enterRoom(page, room.code);
  await expectConnection(page, "open");

  await page.evaluate(() => (globalThis as any).__pokerTest.closeSocket());
  // The reconnect kicks in after ~250ms, so assert closed AND painted in one
  // atomic poll rather than sampling twice and racing the recovery.
  await page.waitForFunction(() => {
    const status = document.querySelector("[data-connection]")?.getAttribute("data-connection");
    const line = document.querySelector("[data-connection-line]") as HTMLElement | null;
    return status === "closed" && line !== null && !line.hidden;
  });
  // The line reports the real problem while we are in a room: hide it, not the truth.
  await expect(line(page)).toHaveText(/closed/);

  await expectConnection(page, "open");
  await expect(line(page)).toBeVisible();
});
