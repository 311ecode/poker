# POKER-017 — quieter identity + link-first room entry

**Project:** poker (main) · **Created:** 2026-09-14
**Reporter:** user — *"this and this is a bit too much maybe … we might want it to be more subtle …
if the user gets a link to a room and can get there and/or can type the pincode"*.
**Status:** **DONE — pushed (`1286a01`) and live at https://poker.imre.dev.**
**Scope:** presentation + entry flow only. The anonymity contract (POKER-001 §1.2 R1–R7) and the
WebSocket protocol are untouched.

---

## 0. Decisions (user, 2026-09-14)

- [x] **D1 = B — hero once, whisper inside.** Block art is the hero on Home; the site header
      carries no art inside a room; the room title is whispered.
- [x] **D2 = A — one field, one job.** Home shows only the room code; Create is behind a
      disclosure; the passcode is asked at the gate, on the room, only after the server refuses.
- [x] **D3 = c — both, default code-only.** The invite link is code-only by default, with an
      explicit *include passcode* checkbox for zero-typing sharing.
- [x] **D3 extras = all three.** Focus the gate/code field · inline the error next to the field ·
      remember an accepted passcode per room.

### One deviation, forced by an existing assertion (recorded deliberately)

D1-B's sketch said "no block art inside a room". `e2e/presentation.spec.ts` AC9 (lines 242–245)
asserts the room banner's five-row `<pre>` **returns at desktop width** — the 480px fold must stay
reversible. So "whisper inside" is implemented as: **the site-header banner is gone inside a room**,
and the room's own title banner **keeps its `<pre>` but is whispered** (8px, muted, no glow,
vs 11.2px for the Home hero). The alternative — swapping the room title to the one-line treatment —
would have required weakening a landed guard, which D1-B explicitly promised not to do.

---

## 1. What landed

**Home (D2-A)** — `public/index.html`
- One `[data-section="enter"]` card: the code field + `Enter`, and one hint line.
  `[data-input="join-passcode"]` is **gone** from Home (a passcode is never asked before it is known
  to be needed).
- Create moved into `<details data-create-disclosure>` with `summary[data-action="toggle-create"]`.
- `[data-section="find"]` / `[data-section="my-rooms"]` banners use `banner--text` (single-row
  letterspaced) and their `<h2>`s are `visually-hidden`, so each section has **one** visible label
  instead of art + heading.

**Room + gate (D3)** — `public/index.html`, `public/app.js`, `public/style.css`
- `[data-panel="room"]` carries `data-room-state`: `connecting` · `gate` · `missing` · `live`.
- New `[data-gate]` block holds the `[data-form="retry-join"]` (hooks unchanged) and is the only
  thing shown when gated; the room's sections, title banner, claim form and invite line are hidden
  until `live`.
- **One** `[data-error]` alert node is **moved** into the gate while gated and back to the header
  otherwise (`renderEntryFlow`) — the message sits next to the field it is about without a second
  alert node and without weakening `expectError` (it stays visible in both states).
- The room title banner keeps its `<pre>` (AC9) but is `banner--whisper`.
- Invite line `[data-share]`: readonly `[data-invite-url]` + `Copy` + an *include passcode*
  checkbox (`[data-input="invite-include-passcode"]`) that only appears when this browser knows a
  passcode.
- `applyRoute` falls back to `readPasscode(storage, code)` when the URL carries none, and
  `showError("bad_passcode")` drops a refused passcode via `forgetPasscode`, so a correct one is
  remembered and a stale/mistyped one is not retried forever.
- Focus: the gate field on `gate`, the code field on Home (never stealing focus, and never popping
  the mobile keyboard — `compactQuery`).

**Look (D1-B)** — `public/style.css`
- `.site-header .banner-pre`: 11.2px, muted, no glow; `body[data-view="room"] .site-header .banner`
  is hidden.
- `.banner--text` (Home sections, history) and `.banner--whisper` (room title, 8px muted).
- Per-vote and reveal banners are content, not chrome — their art is unchanged.

**Tests**
- `e2e/helpers.ts` `joinViaForm` now goes through the real flow: code → gate → passcode → retry.
- `e2e/rooms.spec.ts` `createViaUi` opens the Create disclosure first.
- New `e2e/entry.spec.ts` (5 specs): one-field Home · code-only link into an open room · the gate
  (state, in-place error, focused field, wrong then right passcode) · invite link default and
  opt-in passcode + remembered passcode across a reload · D1-B hero/whisper with a measured
  font-size comparison.

### New `data-*` hooks (nothing renamed)
`data-room-state`, `data-gate`, `data-share`, `data-share-passcode`, `data-invite-url`,
`data-input="invite-include-passcode"`, `data-create-disclosure`, `data-action="toggle-create"`.

---

## 2. Verification

| Gate | Command | Result |
|---|---|---|
| Unit | `npm test` | **117 tests / 12 suites / 0 fail** |
| E2E | `npm run test:e2e` | **38 passed / 3 skipped (gated live smoke) / 0 failed** (28.3s, 1 worker) |

Rendered checks (local server, Chromium, 1280 & 390 px): room title `<pre>` → **1104×40 @ 8px**
desktop, `display:none` at 390px with the compact line visible; header brand `display:none` in a
room; horizontal overflow **0** at both widths; invite value
`http://127.0.0.1:<port>/#/room/<CODE>` (no passcode).

Screenshots for review (outside the repo, `~/dev/poker-shots/`): home light/dark, create open, room
light/dark, gate light/dark, mobile home/room/gate.

### Live verification (deployed origin, 2026-09-14)

g2 was at `aead322` (POKER-014) with a clean tree; `package.json` / `package-lock.json` /
`server.ts` were unchanged across `aead322..1286a01`, so no reinstall was needed.
`git fetch origin && git reset --hard origin/main` → `1286a01`, `pm2 restart poker` → online.

| Check | Result |
|---|---|
| `GET /api/health` | `ok:true`, `build:1789382280531` |
| Deployed HTML | `data-create-disclosure`, `data-gate`, `data-invite-url`, `data-room-state` present; `join-passcode` **absent**; assets stamped `?v=<build>` |
| `npm run test:e2e:live` (sanctioned smoke) | **3 passed** |
| Live entry-flow probe (temporary, cleaned up) | **17/17** — one-field Home · 3 visible banners · gate state + in-place error + focused field · wrong passcode stays · right passcode admits · invite code-only then opt-in passcode · header art hidden in room · title whispered (8px, 40px tall) · reload with a passcode-less link goes straight in |
| Production rooms after the run | **8** — the same pre-existing rooms, no `test`/`live-` leftovers |

---

## 3. Acceptance criteria

- [x] AC1 — no horizontal overflow at 1280/390 (probed: 0) and the 320/360px e2e guard still passes.
- [x] AC2 — contrast assertions still pass in both themes (unchanged tokens; whisper ink is `--muted`,
      6.87:1 light / 10.52:1 dark on `--bg`).
- [x] AC3 — Home's primary action is the first control; Create is a disclosure.
- [x] AC4 — a code-only link lands in an open room, and at the gate when protected.
- [x] AC5 — a wrong passcode keeps the visitor on the room, focuses the field, does not reload.
- [x] AC6 — `npm test` + `npm run test:e2e` green; `presentation.spec.ts` needed **no** change.
- [x] AC7 — no change to vote rendering or the anonymity rules; all anonymity/identity specs green.

## 4. Files

`public/index.html` · `public/style.css` · `public/app.js` · `e2e/entry.spec.ts` (new) ·
`e2e/helpers.ts` · `e2e/rooms.spec.ts` · this ticket.

## 5. Landing

- [x] Pushed to `311ecode/poker` (`114eef2..1286a01`); deployed on g2 (`git reset --hard
      origin/main`, PM2 restart) and verified live (table above).
- [x] No `/resetdata` was called on the deployed origin; the live suites deleted their own test
      rooms.
- [x] Ticket moved to `tickets/done/` with `git mv`.
