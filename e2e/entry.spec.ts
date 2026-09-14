// e2e/entry.spec.ts — POKER-017/POKER-019: the entry flow.
//
//   D1-B  the five-row block art is the hero on Home and only whispered in a room
//   D2-A  Home is one field (the code); Create sits behind a disclosure
//   D3    a room link lands at the passcode gate when protected, then at the name
//         gate, and only then in the room
//   POKER-019  an unidentified visitor is asked who they are — by link or by
//         typed code — and sees nothing of the room until they answer
//
// Presentation through `data-*` hooks only — never rendered prose, never the
// artwork's pixels.

import { expect, test, type Page } from "@playwright/test";
import { claimName, createRoomViaApi, expectConnection, uniqueTitle } from "./helpers.js";

const roomPanel = (page: Page) => page.locator('[data-panel="room"]');

test("D2-A: Home is one field; Create is a disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('[data-input="join-code"]')).toBeVisible();
  // The home form no longer asks for a passcode nobody knows yet.
  await expect(page.locator('[data-input="join-passcode"]')).toHaveCount(0);

  const title = page.locator('[data-input="create-title"]');
  await expect(title).toBeHidden();
  await page.locator('[data-action="toggle-create"]').click();
  await expect(title).toBeVisible();
  await expect(page.locator('[data-input="create-public"]')).toBeVisible();
});

test("POKER-019: a code-only link to an open room asks for a name before showing the room", async ({
  page,
  request,
}) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("open-link") });

  await page.goto(`/#/room/${room.code}`);
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "name");
  // The gate is the only thing on offer, and the cursor is already in it.
  await expect(page.locator('[data-input="name"]')).toBeFocused();
  await expect(page.locator('[data-section="votes"]')).toBeHidden();
  await expect(page.locator("[data-share]")).toBeHidden();

  await claimName(page, "LinkVisitor");
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "live");
  await expectConnection(page, "open");
  await expect(page.locator('[data-input="room-passcode"]')).toBeHidden();
});

test("D3: a protected room asks at the passcode gate, then the name gate, and refuses the wrong passcode in place", async ({
  page,
  request,
}) => {
  const room = await createRoomViaApi(request, {
    title: uniqueTitle("gated"),
    passcode: "s3cret",
  });

  await page.goto(`/#/room/${room.code}`);

  // The refusal is a first-class state, not a broken room.
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "gate");
  await expect(page.locator("[data-error]")).toHaveAttribute("data-error", "bad_passcode");
  await expect(page.locator("[data-gate] [data-error]")).toBeVisible();
  // The room's own furniture is not offered before admission.
  await expect(page.locator('[data-section="votes"]')).toBeHidden();
  await expect(page.locator('[data-input="name"]')).toBeHidden();

  // D3 extras: the cursor is already in the field that needs it.
  await expect(page.locator('[data-input="room-passcode"]')).toBeFocused();

  // A wrong passcode keeps the visitor on the same room, at the same gate.
  await page.locator('[data-input="room-passcode"]').fill("nope");
  await page.locator('[data-action="retry-join"]').click();
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "gate");
  await expect(page.locator("[data-error]")).toHaveAttribute("data-error", "bad_passcode");
  await expect(page.locator("[data-you-name]")).toHaveText("");

  // The right one gets past the passcode — and straight into the name gate.
  await page.locator('[data-input="room-passcode"]').fill("s3cret");
  await page.locator('[data-action="retry-join"]').click();
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "name");
  await expect(page.locator('[data-input="name"]')).toBeFocused();

  await claimName(page, "GateVisitor");
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "live");
  await expectConnection(page, "open");
  await expect(page.locator("[data-error]")).toHaveAttribute("data-error", "");
});

test("D3-c: the invite link is code-only by default and carries the passcode only when asked", async ({
  page,
  request,
}) => {
  const room = await createRoomViaApi(request, {
    title: uniqueTitle("remembered"),
    passcode: "s3cret",
  });

  await page.goto(`/#/room/${room.code}?passcode=s3cret`);
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "name");
  await claimName(page, "Sharer");
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "live");
  await expectConnection(page, "open");

  const invite = page.locator("[data-invite-url]");
  await expect(invite).toBeVisible();
  const codeOnly = await invite.inputValue();
  expect(codeOnly.endsWith(`/#/room/${room.code}`)).toBe(true);
  expect(codeOnly).not.toContain("passcode");

  await page.locator('[data-input="invite-include-passcode"]').check();
  expect(await invite.inputValue()).toContain("?passcode=s3cret");
  await page.locator('[data-input="invite-include-passcode"]').uncheck();
  expect(await invite.inputValue()).not.toContain("passcode");

  // D3 extras: the accepted passcode is remembered per room, so a passcode-less
  // link (a refresh, or a re-open from My Rooms) does not re-prompt. Reload so
  // this exercises the storage, not the in-memory state.
  await page.evaluate((code) => {
    window.location.hash = `#/room/${code}`;
  }, room.code);
  await page.reload();
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "live");
  await expectConnection(page, "open");
  // POKER-007 is intact: an admitted member can still read the passcode back.
  await expect(page.locator("[data-room-passcode]")).toHaveText("s3cret");
});

test("D1-B: the block art is the hero on Home and only whispered inside a room", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const brandPre = page.locator("header [data-banner]").first().locator("[data-banner-pre]");
  await expect(brandPre).toBeVisible();
  const brandSize = await brandPre.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));

  const room = await createRoomViaApi(request, { title: uniqueTitle("quiet") });
  await page.goto(`/#/room/${room.code}`);
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "name");
  await claimName(page, "Quiet");
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "live");

  // The header carries no block art in a room — the room-bar is the plain line…
  await expect(page.locator("header [data-banner]")).toBeHidden();
  // …while the room's own title is the same generated art, whispered (AC9 keeps
  // the five-row <pre>, so this is a size/ink change, not a fold change).
  const roomPre = page.locator("[data-room-banner] [data-banner-pre]");
  await expect(roomPre).toBeVisible();
  await expect(page.locator("[data-room-banner]")).toHaveAttribute("data-banner-text", room.title);
  const roomSize = await roomPre.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(roomSize).toBeLessThan(brandSize);
  // And the invite link lives in the room bar.
  await expect(page.locator("[data-share]")).toBeVisible();
});

// ---------------------------------------------------------------------------
// POKER-020: no dead ends. A refusal that is not about the passcode — or an
// identity the server already holds — must still leave a way forward.
// ---------------------------------------------------------------------------

test("POKER-020: two tabs racing one session's name do not trap the loser at the gate", async ({
  browser,
  request,
}) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("resync") });
  const context = await browser.newContext();
  try {
    // Seed ONE session before either tab boots. Two tabs loading at once would
    // otherwise race `ensureSession` and could keep their own ids — then the race
    // under test (a name is locked per session) would not happen at all.
    await context.addInitScript(() => {
      if (!localStorage.getItem("poker.session")) {
        localStorage.setItem("poker.session", "s-99999999-9999-4999-8999-999999999999");
      }
    });
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([a.goto(`/#/room/${room.code}`), b.goto(`/#/room/${room.code}`)]);
    await Promise.all([
      a.waitForSelector('[data-room-state="name"]'),
      b.waitForSelector('[data-room-state="name"]'),
    ]);

    // Both claim at once. A name is locked per session, so exactly one wins and
    // the other is told `name_locked` — which must re-sync, not trap.
    await Promise.all([
      (async () => {
        await a.locator('[data-input="name"]').fill("TabA");
        await a.locator('[data-action="claim-name"]').click();
      })(),
      (async () => {
        await b.locator('[data-input="name"]').fill("TabB");
        await b.locator('[data-action="claim-name"]').click();
      })(),
    ]);

    await expect(a.locator('[data-panel="room"]')).toHaveAttribute("data-room-state", "live");
    await expect(b.locator('[data-panel="room"]')).toHaveAttribute("data-room-state", "live");
    // The loser's gate closes the moment the shared storage shows the winner's
    // name (nameIsThePath() reads it), and its own name arrives one round trip
    // later from the re-sync hello — so WAIT for the name, never sample it in the
    // same breath as the state.
    await expect(a.locator("[data-you-name]")).not.toHaveText("", { timeout: 15_000 });
    await expect(b.locator("[data-you-name]")).not.toHaveText("", { timeout: 15_000 });
    const nameA = await a.locator("[data-you-name]").textContent();
    const nameB = await b.locator("[data-you-name]").textContent();
    expect(nameA).toBe(nameB);
    await expect(a.locator("[data-error]")).toHaveAttribute("data-error", "");
    await expect(b.locator("[data-error]")).toHaveAttribute("data-error", "");
    await expect(a.locator('[data-section="votes"]')).toBeVisible();
    await expect(b.locator('[data-section="votes"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

test("POKER-020: a refusal that is not the passcode offers a retry, never a dead connecting screen", async ({
  page,
  request,
}) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("retrycard") });
  // Answer the client's FIRST hello with a non-passcode refusal. The flag lives
  // OUTSIDE the handler: routeWebSocket runs it once per WebSocket, so a flag
  // inside would refuse every reconnection too.
  let refused = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }
      if (json?.t === "hello" && !refused) {
        refused = true;
        ws.send(JSON.stringify({ t: "error", code: "server_error" }));
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await page.goto(`/#/room/${room.code}`);
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "retry");
  await expect(page.locator("[data-retry]")).toBeVisible();
  // The refusal is explained in place, with the way forward right there.
  await expect(page.locator("[data-retry] [data-error]")).toHaveAttribute(
    "data-error",
    "server_error",
  );
  const retry = page.locator('[data-action="retry-connect"]');
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();

  // Trying again is admitted (only the first hello was refused).
  await retry.click();
  await expect(roomPanel(page)).toHaveAttribute("data-room-state", "name");
  await expect(page.locator('[data-input="name"]')).toBeVisible();
});
