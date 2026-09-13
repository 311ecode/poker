// e2e/name-claim.spec.ts — AC3: a name is claimed per room, a duplicate is
// rejected IN REALTIME (case-insensitively) and the UI says why (R7).

import { expect, test } from "@playwright/test";
import {
  claimName,
  connectRoom,
  createRoomViaApi,
  expectConnection,
  expectError,
  uniqueTitle,
} from "./helpers.js";

test("AC3: claim a name; a duplicate held by context A is rejected in context B with a visible reason", async ({ browser, request }) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("names") });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await connectRoom(contextA, room.code, { name: "Alice" });
    const b = await connectRoom(contextB, room.code);

    // B is in the room but unnamed until it claims.
    await expect(b.page.locator("[data-you-name]")).toHaveText("");
    await expect(b.page.locator("[data-you-session]")).not.toHaveText("");
    // POKER-002 AC5: while unnamed the claim form is the gate.
    await expect(b.page.locator('[data-form="claim"]')).toBeVisible();

    // An empty claim is a clean error, not a crash.
    await claimName(b.page, "");
    await expectError(b.page, "bad_name");

    // A holds "Alice"; B tries the same name in different case.
    for (const attempt of ["Alice", "alice", "ALICE"]) {
      await claimName(b.page, attempt);
      await expectError(b.page, "name_taken");
      await expect(b.page.locator("[data-you-name]")).toHaveText("");
    }

    // The roster still shows A's name (names of members are public; ballots are not).
    await expect(a.page.locator('[data-member][data-member-name="Alice"]')).toHaveCount(1);

    // A free name works, and fans out to A in realtime.
    await claimName(b.page, "Bob");
    await expect(b.page.locator("[data-you-name]")).toHaveText("Bob");
    await expect(a.page.locator('[data-member][data-member-name="Bob"]')).toHaveCount(1);

    // POKER-002 AC3/AC5: the name is permanent — the claim form is gone, so the
    // UI offers no way to change it (the server refuses too; see unit tests).
    await expect(b.page.locator('[data-form="claim"]')).toBeHidden();

    // The claimed name is server-authoritative: it survives a reload.
    await b.page.reload();
    await expectConnection(b.page, "open");
    await expect(b.page.locator("[data-you-name]")).toHaveText("Bob");
    await expect(b.page.locator('[data-form="claim"]')).toBeHidden();
    await expect(b.page.locator("[data-error]")).toHaveAttribute("data-error", "");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
