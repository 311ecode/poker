# POKER-007 — show the room's passcode inside the room so members can share it

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — *"it's right that the passcode is written in the room so people can get into
there"* → clarified: **show the passcode inside the room so members can share it.**
**Status:** IN PROGRESS

## 0. Decision

An admitted member sees the room's passcode in the room, with a **Copy** button.

**Client-side only — deliberately.** Every member who is in a passcode-protected room necessarily
supplied that passcode on this browser (join form, retry form, or the `?passcode=` invite query), so
the browser already has it. Remembering it per room in `localStorage` and rendering it back gives
members the share affordance **without** storing plaintext on the server or putting the passcode on
the unauthenticated HTTP surface. POKER-001 §1.1's `passcodeHash` / "never the passcode" rule is
untouched: `/api/rooms` and `/api/rooms/:code` still never carry it.

Scope: display + copy, nothing more (no invite links, no QR codes).

## 1. Acceptance criteria

- [ ] AC1 — `localStorage["poker.passcode.<CODE>"]` is written when an admitted member hello'd with a
  passcode (created room, join form, retry form, or invite query).
- [ ] AC2 — In a protected room the client renders `Passcode: <code>` (`[data-room-passcode]`) plus a
  Copy button; in a room with no passcode the line is absent.
- [ ] AC3 — The passcode still never appears in `/api/rooms`, `/api/rooms/:code`, `roomMeta` or any
  public frame (the existing HTTP assertions keep holding).
- [ ] AC4 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to `tickets/done/`.

## 2. Files

`public/store.js` (per-room passcode store), `public/index.html` (the line + button),
`public/app.js` (persist on `hello_ok`, render, copy), `public/style.css`, `test/store.test.ts`,
`e2e/rooms.spec.ts`, this ticket.
