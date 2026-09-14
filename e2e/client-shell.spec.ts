// e2e/client-shell.spec.ts — AC11: the client is served from `public/` with
// `Cache-Control: no-cache`, as plain ES modules, with no build step.

import { expect, test } from "@playwright/test";
import { createRoomViaApi, uniqueTitle } from "./helpers.js";

test("AC11: public/ is no-cache, plain ES modules, no build step", async ({ request, page }) => {
  const index = await request.get("/");
  expect(index.status()).toBe(200);
  expect(index.headers()["cache-control"]).toBe("no-cache");
  expect(index.headers()["content-type"]).toContain("text/html");
  const html = await index.text();
  expect(html).toContain('type="module"');
  expect(html).toContain("./app.js");

  for (const asset of ["/app.js", "/store.js", "/leakguard.js", "/messages.js"]) {
    const response = await request.get(asset);
    expect(response.status(), `${asset} is served`).toBe(200);
    expect(response.headers()["cache-control"], `${asset} no-cache`).toBe("no-cache");
    expect(response.headers()["content-type"], `${asset} is JS`).toContain("text/javascript");
  }

  // A real ES-module graph, not a bundle: app.js imports its siblings by URL.
  // POKER-009: every specifier is build-stamped so a CDN cannot serve a stale
  // module.
  const app = await (await request.get("/app.js")).text();
  expect(app).toMatch(/from "\.\/store\.js\?v=[^"]+"/);
  expect(app).toMatch(/from "\.\/leakguard\.js\?v=[^"]+"/);

  // The HTML entry points carry the same stamp.
  expect(html).toMatch(/src="\.\/app\.js\?v=[^"]+"/);
  expect(html).toMatch(/href="\.\/style\.css\?v=[^"]+"/);

  // The shell boots in a browser and exposes the data-* hooks the specs use.
  await page.goto("/");
  await expect(page.locator('[data-panel="home"]')).toBeVisible();
  // POKER-015: the attribute hook stays, but the line is hidden on home — there
  // is no room socket to report there. See e2e/connection-indicator.spec.ts.
  await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "closed");
  await expect(page.locator("[data-connection-line]")).toBeHidden();
  await expect(page.locator("[data-my-rooms]")).toBeAttached();
  await expect(page.locator("[data-rooms]")).toBeAttached();
  expect(await page.evaluate(() => typeof (globalThis as any).__pokerTest)).toBe("object");
  expect(await page.evaluate(() => Array.isArray((globalThis as any).__pokerFrames))).toBe(true);
});

test("POKER-014: every screen carries the attribution footer", async ({ page, request }) => {
  await page.goto("/");
  const footer = page.locator("footer.site-footer");
  await expect(footer).toBeVisible();

  const home = footer.locator('a[href="https://imre.dev"]');
  const source = footer.locator('a[href="https://github.com/311ecode/poker"]');
  await expect(home).toHaveText("imre.dev");
  await expect(source).toHaveText("source");
  for (const link of [home, source]) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  }

  // The footer lives outside the panels, so the Room screen has it too.
  const room = await createRoomViaApi(request, { title: uniqueTitle("footer") });
  await page.goto(`/#/room/${room.code}`);
  await expect(page.locator('[data-panel="room"]')).toBeVisible();
  await expect(page.locator("footer.site-footer")).toBeVisible();
  await expect(page.locator('footer.site-footer a[href="https://imre.dev"]')).toBeVisible();
});
