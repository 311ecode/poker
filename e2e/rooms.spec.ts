// e2e/rooms.spec.ts — AC4: create a room from the UI, `Find rooms` lists
// DISCOVERABLE rooms (the `public` flag) with `hasPasscode` as an advisory
// boolean, a protected room stays gated, and a wrong passcode is refused
// visibly.
//
// Coordinator ruling (2026-09-13): parent §1.5's "never passcode-protected
// ones" is loose prose contradicted by §1.4's own `hasPasscode:true` example and
// by 001a AC9 / 001b AC7. `public` governs discoverability; a `public:true`
// room with a passcode is listed and gated. The list/metadata must never expose
// the passcode or its hash.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { claimName, expectConnection, expectError, goHome, openHome, createRoomViaApi, uniqueTitle } from "./helpers.js";

const summary = (page: Page, code: string): Locator =>
  page.locator(`[data-room-summary][data-room-summary-code="${code}"]`);

async function createViaUi(page: Page, title: string, passcode = ""): Promise<string> {
  // POKER-017 (D2-A): Create is a disclosure on Home — open it before filling.
  const titleInput = page.locator('[data-input="create-title"]');
  if (!(await titleInput.isVisible())) {
    await page.locator('[data-action="toggle-create"]').click();
  }
  await titleInput.fill(title);
  await page.locator('[data-input="create-passcode"]').fill(passcode);
  await page.locator('[data-action="create"]').click();
  await expect(page.locator('[data-panel="room"]')).toBeVisible();
  const code = (await page.locator("[data-room-code]").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

test("AC4: create + find rooms; a protected room is discoverable but gated; wrong passcode refused", async ({ browser, request }) => {
  const context = await browser.newContext();
  const stranger = await browser.newContext();
  try {
    const page = await openHome(context);

    // --- create a public room through the UI ---
    const publicCode = await createViaUi(page, uniqueTitle("findme"));
    await expectConnection(page, "open");
    // POKER-007: no passcode → no passcode line.
    await expect(page.locator("[data-room-passcode-line]")).toBeHidden();

    await goHome(page);
    await page.locator('[data-action="find-rooms"]').click();
    await expect(summary(page, publicCode)).toHaveCount(1);
    await expect(summary(page, publicCode)).toHaveAttribute("data-has-passcode", "false");

    // --- create a public-but-passcode-protected room through the UI ---
    const secretCode = await createViaUi(page, uniqueTitle("secret"), "s3cret");
    expect(secretCode).not.toBe(publicCode);

    await goHome(page);
    await page.locator('[data-action="find-rooms"]').click();
    await expect(summary(page, publicCode)).toHaveCount(1);
    // Discoverable (public), and the client is told it needs a passcode.
    await expect(summary(page, secretCode)).toHaveCount(1);
    await expect(summary(page, secretCode)).toHaveAttribute("data-has-passcode", "true");

    // --- the passcode and its hash are NEVER on the HTTP surface ---
    const listBody = await (await request.get("/api/rooms")).text();
    expect(listBody).not.toContain("s3cret");
    expect(listBody.toLowerCase()).not.toContain("passcodehash");
    const list = JSON.parse(listBody) as { rooms: Record<string, unknown>[] };
    const entry = list.rooms.find((room) => room.code === secretCode)!;
    expect(entry.hasPasscode).toBe(true);
    expect(Object.keys(entry).sort()).toEqual(["code", "hasPasscode", "members", "title"]);

    const metaBody = await (await request.get(`/api/rooms/${secretCode}`)).text();
    expect(metaBody).not.toContain("s3cret");
    expect(metaBody.toLowerCase()).not.toContain("passcodehash");
    expect((JSON.parse(metaBody) as { room: { hasPasscode: boolean } }).room.hasPasscode).toBe(true);

    // --- a `public: false` room is NOT discoverable at all ---
    const privateRoom = await createRoomViaApi(request, {
      title: uniqueTitle("private"),
      public: false,
      passcode: "hunter2",
    });
    // The page is still on Home; refresh the findable list in place.
    await page.locator('[data-action="find-rooms"]').click();
    await expect(summary(page, privateRoom.code)).toHaveCount(0);
    const listAfter = await (await request.get("/api/rooms")).text();
    expect(listAfter).not.toContain(privateRoom.code);
    expect(listAfter).not.toContain("hunter2");
    expect(listAfter.toLowerCase()).not.toContain("passcodehash");

    // --- a stranger with the wrong passcode is refused, visibly ---
    const noPasscode = await stranger.newPage();
    await noPasscode.goto(`/#/room/${secretCode}`);
    await expectError(noPasscode, "bad_passcode");
    await noPasscode.close();

    const intruder = await stranger.newPage();
    await intruder.goto(`/#/room/${secretCode}?passcode=wrong`);
    await expectError(intruder, "bad_passcode");
    await expect(intruder.locator("[data-you-name]")).toHaveText("");

    // …and the same page can retry with the right one.
    await intruder.locator('[data-input="room-passcode"]').fill("s3cret");
    await intruder.locator('[data-action="retry-join"]').click();
    await expectConnection(intruder, "open");
    await expect(intruder.locator("[data-error]")).toHaveAttribute("data-error", "");
    await expect(intruder.locator("[data-you-session]")).not.toHaveText("");
    // POKER-019: past the passcode, an unidentified visitor still answers the
    // name gate before the room's own controls appear.
    await expect(intruder.locator('[data-panel="room"]')).toHaveAttribute("data-room-state", "name");
    await claimName(intruder, "Intruder");
    await expect(intruder.locator("[data-you-name]")).toHaveText("Intruder");
    // POKER-007: an admitted member can read the passcode back and share it.
    await expect(intruder.locator("[data-room-passcode]")).toHaveText("s3cret");

    // --- a truly unknown room is a clean error too ---
    await goHome(intruder);
    await intruder.locator('[data-input="join-code"]').fill("ZZZZZZ");
    await intruder.locator('[data-action="join"]').click();
    await expectError(intruder, "bad_room");
  } finally {
    await context.close();
    await stranger.close();
  }
});
