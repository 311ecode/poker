// playwright.config.ts — Playwright from zero for poker (POKER-001c AC1/AC2).
//
// Copied in spirit from offtube: ONE random free port per run, shared through
// an environment variable because Playwright evaluates this config more than
// once (runner + worker processes) — probing a fresh port per evaluation is the
// classic false red. The spawned server gets its own fresh temp DATA_DIR, so
// `npm run test:e2e` is repeatable and never sees a developer's ./data.
//
// `LIVE=1` (used by `npm run test:e2e:live`) disables the spawned server: the
// smoke spec talks to the deployed origin instead.

import { defineConfig } from "@playwright/test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ask the OS for a random free port (bind to 0, then release it). */
function randomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const live = Boolean(process.env.LIVE);

// ONE port for the whole run; shared with the worker processes through env.
const envPort = process.env.POKER_E2E_PORT;
const port = envPort ? Number(envPort) : await randomFreePort();
process.env.POKER_E2E_PORT = String(port);

// ONE isolated data dir for the whole run; also shared through env so specs can
// assert the server holds no per-browser history (AC5).
const envDataDir = process.env.POKER_E2E_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(path.join(os.tmpdir(), "poker-e2e-"));
process.env.POKER_E2E_DATA_DIR = dataDir;

const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The suite is deterministic by design; parallel workers and orphaned
  // webServers are the usual false red. One worker, never concurrent.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
  },
  // The live smoke talks to https://poker.imre.dev and must not spawn a server.
  webServer: live
    ? undefined
    : {
        command: "node server.ts",
        url: `${baseURL}/api/health`,
        env: { PORT: String(port), DATA_DIR: dataDir },
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
