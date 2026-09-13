// e2e/auto-update.spec.ts — POKER-008: a tab left open across a deploy must not
// keep running a superseded client. The server stamps its assets on
// /api/health; the page compares that stamp and reloads itself when it changes.

import { expect, test } from "@playwright/test";
import { countNavigations } from "./helpers.js";

test("POKER-008: the client reloads itself when the deployed build changes", async ({ page }) => {
  let build = "build-1";
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    body.build = build;
    await route.fulfill({ response, json: body });
  });

  const navigations = countNavigations(page);
  await page.goto("/");
  await expect(page.locator('[data-panel="home"]')).toBeVisible();

  // The boot probe records the build this page started on.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker.build")))
    .toBe("build-1");
  const before = navigations();

  // Unchanged build → no reload, however often we probe.
  await page.evaluate(() => (globalThis as any).__pokerTest.checkBuild());
  await page.waitForTimeout(250);
  expect(navigations()).toBe(before);

  // A deploy lands → the next probe reloads the page exactly once.
  build = "build-2";
  await page.evaluate(() => (globalThis as any).__pokerTest.checkBuild());
  await expect.poll(() => navigations(), { timeout: 5000 }).toBe(before + 1);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("poker.build")))
    .toBe("build-2");

  // …and the fresh page does not loop.
  await page.waitForTimeout(400);
  expect(navigations()).toBe(before + 1);
});
