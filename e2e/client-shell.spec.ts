// e2e/client-shell.spec.ts — AC11: the client is served from `public/` with
// `Cache-Control: no-cache`, as plain ES modules, with no build step.

import { expect, test } from "@playwright/test";

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
  const app = await (await request.get("/app.js")).text();
  expect(app).toContain('from "./store.js"');
  expect(app).toContain('from "./leakguard.js"');

  // The shell boots in a browser and exposes the data-* hooks the specs use.
  await page.goto("/");
  await expect(page.locator('[data-panel="home"]')).toBeVisible();
  await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", "closed");
  await expect(page.locator("[data-my-rooms]")).toBeAttached();
  await expect(page.locator("[data-rooms]")).toBeAttached();
  expect(await page.evaluate(() => typeof (globalThis as any).__pokerTest)).toBe("object");
  expect(await page.evaluate(() => Array.isArray((globalThis as any).__pokerFrames))).toBe(true);
});
