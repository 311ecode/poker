// e2e/helpers.ts — shared fixtures for the poker specs (POKER-001c).
//
// Deliberately NOT a *.spec.ts file so every spec may import it. Two things it
// owns:
//   * the `data-*` hook vocabulary (specs never scrape prose), and
//   * `recordFrames()` — the native `page.on("websocket")` capture that makes
//     AC7 an assertion about the real wire, not about the DOM.

import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { promises as fsp } from "node:fs";
import path from "node:path";

/** A unique room title so specs sharing one DATA_DIR never collide. */
export function uniqueTitle(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface RoomMeta {
  code: string;
  title: string;
  hasPasscode: boolean;
  memberCount: number;
}

/** POST /api/rooms (parent §1.5) and return its metadata. */
export async function createRoomViaApi(
  request: APIRequestContext,
  input: { title: string; public?: boolean; passcode?: string },
): Promise<RoomMeta> {
  const response = await request.post("/api/rooms", { data: input });
  expect(response.ok(), `POST /api/rooms -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { room: RoomMeta };
  expect(body.room.code).toMatch(/^[A-Z0-9]{6}$/);
  return body.room;
}

// ---------------------------------------------------------------------------
// the raw wire
// ---------------------------------------------------------------------------

export interface FrameLog {
  url: string;
  payload: string;
  json: Record<string, any> | null;
}

/**
 * Record every frame the page RECEIVES, via Playwright's native WebSocket
 * observability. Attach before `goto` so the handshake is captured too.
 */
export function recordFrames(page: Page): FrameLog[] {
  const frames: FrameLog[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (event) => {
      const payload = typeof event.payload === "string" ? event.payload : event.payload.toString("utf8");
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(payload) as Record<string, any>;
      } catch {
        json = null;
      }
      frames.push({ url: ws.url, payload, json });
    });
  });
  return frames;
}

/** Frames received since `index` (the `frames` array is append-only). */
export function framesSince(frames: FrameLog[], index: number): string[] {
  return frames.slice(index).map((frame) => frame.payload);
}

/** Count main-frame navigations, to prove a change arrived "without a reload". */
export function countNavigations(page: Page): () => number {
  let count = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) count += 1;
  });
  return () => count;
}

// ---------------------------------------------------------------------------
// navigation + assertions on the data-* hooks
// ---------------------------------------------------------------------------

export async function expectConnection(page: Page, value: "open" | "closed" | "connecting"): Promise<void> {
  await expect(page.locator("[data-connection]")).toHaveAttribute("data-connection", value);
}

export async function expectError(page: Page, code: string): Promise<void> {
  await expect(page.locator("[data-error]")).toHaveAttribute("data-error", code);
  await expect(page.locator("[data-error]")).toBeVisible();
  await expect(page.locator("[data-error]")).not.toHaveText("");
}

export async function openHome(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator('[data-panel="home"]')).toBeVisible();
  return page;
}

/** Full-page entry into a room URL; waits for hello + the open socket. */
export async function enterRoom(page: Page, code: string, passcode?: string): Promise<void> {
  const query = passcode ? `?passcode=${encodeURIComponent(passcode)}` : "";
  await page.goto(`/#/room/${code}${query}`);
  await expect(page.locator('[data-panel="room"]')).toBeVisible();
  await expect(page.locator("[data-room-code]")).toHaveText(code);
}

export async function claimName(page: Page, name: string): Promise<void> {
  await page.locator('[data-input="name"]').fill(name);
  await page.locator('[data-action="claim-name"]').click();
}

/**
 * Create a fresh context, record its wire, join `code` and optionally claim a
 * name. TWO of these in one spec is the multi-context bar (parent §4.1).
 */
export async function connectRoom(
  context: BrowserContext,
  code: string,
  opts: { name?: string; passcode?: string } = {},
): Promise<{ page: Page; frames: FrameLog[]; navigations: () => number }> {
  const page = await context.newPage();
  const frames = recordFrames(page);
  const navigations = countNavigations(page);
  await enterRoom(page, code, opts.passcode);
  await expectConnection(page, "open");
  if (opts.name !== undefined) {
    await claimName(page, opts.name);
    await expect(page.locator("[data-you-name]")).toHaveText(opts.name);
  }
  return { page, frames, navigations };
}

/** Join a room through the home form (in-app routing, no reload). */
export async function joinViaForm(page: Page, code: string, passcode = ""): Promise<void> {
  await page.locator('[data-input="join-code"]').fill(code);
  if (passcode) await page.locator('[data-input="join-passcode"]').fill(passcode);
  await page.locator('[data-action="join"]').click();
  await expect(page.locator('[data-panel="room"]')).toBeVisible();
  await expect(page.locator("[data-room-code]")).toHaveText(code);
  await expectConnection(page, "open");
}

export async function goHome(page: Page): Promise<void> {
  await page.locator('[data-action="home"]').click();
  await expect(page.locator('[data-panel="home"]')).toBeVisible();
}

// ---------------------------------------------------------------------------
// votes
// ---------------------------------------------------------------------------

/**
 * Open a vote. POKER-002: the deck is server-owned, so only the question is
 * filled — every vote is the fixed deck 0, 0.5, 1, 2, 3, 5, 8, 13.
 */
export async function openVote(page: Page, title: string): Promise<string> {
  await page.locator('[data-input="vote-title"]').fill(title);
  await page.locator('[data-action="open-vote"]').click();
  const card = page.locator("[data-vote]").last();
  await expect(card).toHaveAttribute("data-vote-state", "open");
  const voteId = await card.getAttribute("data-vote-id");
  expect(voteId).toBeTruthy();
  return voteId!;
}

export function voteCard(page: Page, voteId: string) {
  return page.locator(`[data-vote][data-vote-id="${voteId}"]`);
}

export async function castVote(page: Page, voteId: string, choice: string): Promise<void> {
  await page.locator(`[data-vote-id="${voteId}"] [data-choice="${choice}"]`).click();
}

/** POKER-002 AC4: the visible "Your vote" choice on a card. */
export function yourVote(page: Page, voteId: string) {
  return voteCard(page, voteId).locator("[data-your-choice]");
}

export async function voterOrder(page: Page, voteId: string): Promise<string[]> {
  const nodes = page.locator(`[data-vote-id="${voteId}"] [data-voter]`);
  return (await nodes.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-voter-session") ?? ""),
  )) as string[];
}

// ---------------------------------------------------------------------------
// the server's data dir — to prove the server holds no per-browser history
// ---------------------------------------------------------------------------

export function dataDir(): string {
  const dir = process.env.POKER_E2E_DATA_DIR;
  if (!dir) throw new Error("POKER_E2E_DATA_DIR is not set — playwright.config.ts should set it");
  return dir;
}

export async function readRoomFile(code: string): Promise<Record<string, any>> {
  const raw = await fsp.readFile(path.join(dataDir(), "rooms", `${code}.json`), "utf8");
  return JSON.parse(raw) as Record<string, any>;
}
