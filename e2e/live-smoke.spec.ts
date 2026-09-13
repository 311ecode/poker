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

  // POKER-002 verified on the DEPLOYED origin: the fixed deck, the name gate
  // and a visible own vote (the local suite proves the same behaviours offline).
  test("POKER-002 live: fixed deck, name gate and visible own vote", async ({ browser, request }) => {
    const created = await request.post(`${ORIGIN}/api/rooms`, {
      data: { title: uniqueTitle("live-deck"), public: true },
    });
    expect(created.status(), "POST /api/rooms").toBe(200);
    const code = ((await created.json()) as { room: { code: string } }).room.code;

    const named = await browser.newContext();
    const anon = await browser.newContext();
    try {
      const voter = await named.newPage();
      await voter.goto(`${ORIGIN}/#/room/${code}`);
      await expect(voter.locator("[data-connection]")).toHaveAttribute("data-connection", "open");
      await voter.locator('[data-input="name"]').fill("LiveVoter");
      await voter.locator('[data-action="claim-name"]').click();
      await expect(voter.locator("[data-you-name]")).toHaveText("LiveVoter");
      // POKER-005: claimed → the claim form is gone from the DOM.
      await expect(voter.locator('[data-form="claim"]')).toHaveCount(0);

      // An unnamed visitor is gated: claim form only, no vote form.
      const guest = await anon.newPage();
      await guest.goto(`${ORIGIN}/#/room/${code}`);
      await expect(guest.locator("[data-connection]")).toHaveAttribute("data-connection", "open");
      await expect(guest.locator('[data-form="claim"]')).toBeVisible();
      await expect(guest.locator('[data-form="open-vote"]')).toBeHidden();

      // The fixed, server-owned deck, chosen from a select (POKER-004).
      await voter.locator('[data-input="vote-title"]').fill("Live estimate");
      await voter.locator('[data-action="open-vote"]').click();
      // POKER-012: the question box is consumed by the open.
      await expect(voter.locator('[data-input="vote-title"]')).toHaveValue("");
      const card = voter.locator("[data-vote]").last();
      await expect(card).toHaveAttribute("data-vote-state", "open");
      await expect(card.locator("[data-choice-select] option[data-choice]")).toHaveText([
        "0 (0)",
        "0.5 (0)",
        "1 (0)",
        "2 (0)",
        "3 (0)",
        "5 (0)",
        "8 (0)",
        "13 (0)",
      ]);
      await expect(guest.locator("[data-vote]").last().locator("[data-choice-select]")).toBeDisabled();

      // Choosing 3 sends it immediately → my own vote is stated and shown.
      await card.locator("[data-choice-select]").selectOption("3");
      await expect(card.locator("[data-your-choice]")).toHaveText("3");
      await expect(card.locator("[data-choice-select]")).toHaveValue("3");

      // POKER-010: an empty question is auto-numbered (the titled vote was v1).
      await voter.locator('[data-input="vote-title"]').fill("");
      await voter.locator('[data-action="open-vote"]').click();
      await expect(voter.locator("[data-vote]").last().locator("[data-vote-title]")).toHaveText(
        "Vote 2",
      );
    } finally {
      await named.close();
      await anon.close();
    }
  });

  // POKER-003 verified on the DEPLOYED origin: a claimed name is burned into the
  // browser and reused in the next room without the form ever appearing.
  test("POKER-003 live: the claimed name is reused in another room", async ({ browser, request }) => {
    const newRoom = async (prefix: string): Promise<string> => {
      const created = await request.post(`${ORIGIN}/api/rooms`, {
        data: { title: uniqueTitle(prefix), public: true },
      });
      expect(created.status(), "POST /api/rooms").toBe(200);
      return ((await created.json()) as { room: { code: string } }).room.code;
    };
    const roomA = await newRoom("live-name-a");
    const roomB = await newRoom("live-name-b");

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/#/room/${roomA}`);
      await expect(page.locator('[data-form="claim"]')).toBeVisible();
      await page.locator('[data-input="name"]').fill("LiveLife");
      await page.locator('[data-action="claim-name"]').click();
      await expect(page.locator("[data-you-name]")).toHaveText("LiveLife");

      // Room B: named automatically, the form is never the path — and by
      // POKER-005 it does not even exist in the DOM.
      await page.goto(`${ORIGIN}/#/room/${roomB}`);
      await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "open");
      await expect(page.locator("[data-you-name]")).toHaveText("LiveLife");
      await expect(page.locator('[data-form="claim"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
