// e2e/heartbeat.spec.ts — POKER-018: a quiet room must not go silent.
//
// The contract's keepalive (`{"t":"ping"}` → `{"t":"pong"}`, POKER-001 §1.4) was
// answered by the server but never SENT by the client, so a room with no votes
// carried no traffic and the Cloudflare tunnel dropped the idle socket at
// ~100-125s — the "connect / disconnect dance". This asserts the client now
// speaks up, and that the server answers, without waiting 25 real seconds:
// Playwright's fake clock drives the page's timers.

import { expect, test } from "@playwright/test";
import { createRoomViaApi, enterRoom, expectConnection, uniqueTitle } from "./helpers.js";

test("POKER-018: a quiet room pings the server on the contract's keepalive", async ({
  page,
  request,
}) => {
  const room = await createRoomViaApi(request, { title: uniqueTitle("ping") });
  const pings: string[] = [];
  const pongs: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (event) => {
      const text = String(event.payload);
      if (text.includes('"t":"ping"')) pings.push(text);
    });
    ws.on("framereceived", (event) => {
      const text = String(event.payload);
      if (text.includes('"t":"pong"')) pongs.push(text);
    });
  });

  // Fake the page clock BEFORE the app loads so the 25s keepalive can be driven
  // forward instantly.
  await page.clock.install();
  await enterRoom(page, room.code);
  await expectConnection(page, "open");

  expect(pings, "nothing is sent before the first interval").toEqual([]);

  await page.clock.fastForward(30_000);
  await expect.poll(() => pings.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(pings[0]).toBe('{"t":"ping"}');

  // …and the server answered, which is what actually resets the proxy's idle
  // timer in both directions.
  await expect.poll(() => pongs.length, { timeout: 5_000 }).toBeGreaterThan(0);

  // A second interval keeps it going, and the socket was never dropped.
  await page.clock.fastForward(30_000);
  await expect.poll(() => pings.length, { timeout: 5_000 }).toBeGreaterThan(1);
  await expectConnection(page, "open");
});
