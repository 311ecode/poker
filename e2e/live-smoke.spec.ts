// e2e/live-smoke.spec.ts — AC12: a small smoke against the DEPLOYED origin,
// gated so it never runs under plain `npm run test:e2e` (which self-hosts a
// local server). Run it with `LIVE=1 npm run test:e2e:live`.
//
// The host may still be undeployed while POKER-001c is in flight — that is
// expected; the point is that this spec does not run unless LIVE=1.

import { expect, test } from "@playwright/test";
import { uniqueTitle } from "./helpers.js";

const LIVE = Boolean(process.env.LIVE);
const ORIGIN = process.env.POKER_LIVE_ORIGIN ?? "https://poker.imre.dev";

test.describe("live smoke against the deployed origin", () => {
  test.skip(!LIVE, "gated: set LIVE=1 (npm run test:e2e:live) to hit the deployed origin");

  test("health + create-room + name claim", async ({ browser, request }) => {
    const health = await request.get(`${ORIGIN}/api/health`);
    expect(health.status(), `${ORIGIN}/api/health`).toBe(200);
    const healthBody = (await health.json()) as { ok: boolean; version: string };
    expect(healthBody.ok).toBe(true);
    expect(typeof healthBody.version).toBe("string");

    const created = await request.post(`${ORIGIN}/api/rooms`, {
      data: { title: uniqueTitle("live-smoke"), public: true },
    });
    expect(created.status(), "POST /api/rooms").toBe(200);
    const code = ((await created.json()) as { room: { code: string } }).room.code;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/#/room/${code}`);
      await expect(page.locator('[data-panel="room"]')).toBeVisible();
      await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "open");
      await page.locator('[data-input="name"]').fill("Smoke");
      await page.locator('[data-action="claim-name"]').click();
      await expect(page.locator("[data-you-name]")).toHaveText("Smoke");
    } finally {
      await context.close();
    }
  });
});
