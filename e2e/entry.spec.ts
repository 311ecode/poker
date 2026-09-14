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
