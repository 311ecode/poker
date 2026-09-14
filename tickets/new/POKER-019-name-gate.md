# POKER-019 — the name gate: an unidentified visitor is asked who they are, always

**Project:** poker (main) · **Created:** 2026-09-14
**Reporter:** user, from a virgin machine — *"it did not require me to type my name … no matter what,
with a link or not, if the user is not identified [they have] to type the name, and it is all good
after that"*.
**Status:** **DONE** (see §5).
**Supersedes one landed behaviour:** POKER-006's "an unnamed visitor sees the room and reads
'not named yet' on the roster". The roster rule itself stays (never a raw session id) — what changes
is that an unnamed visitor no longer sees the room at all.

## 1. What was wrong

The claim form *was* rendered for a fresh visitor (verified live: `nameVisible: visible`,
`claimFormConnected: true`, `youName: ""`) — it just was not **required**. You could browse members
and votes and sit in the room forever without a name; the name only gated voting. The user's ruling:
an unidentified visitor must be asked, by link or by typed code, before they are in the room.

## 2. Decision (user, 2026-09-14)

> **Hard gate — no room at all until named.** (Offered against "name first, room still readable".)

## 3. What it is now

`[data-panel="room"]` gained a fourth state, so the flow reads as a sequence of doors:

```
connecting → gate (passcode) → name (who are you?) → live (the room)
```

- `data-room-state="name"` while the browser is **admitted, unidentified, and the claim form is the
  path** — i.e. no stored name, or a stored one this room refused (POKER-006's stall guard).
- The name gate (`[data-name-gate]`, `.gate--name`) sits directly under the room-bar and is the only
  thing on offer: **members, votes, history, the passcode line and the invite link are all hidden**
  until a name exists.
- The whisper room *title* stays visible while naming — the room is known by then, so it is context,
  not furniture.
- The single `[data-error]` alert node now moves into **whichever gate is asking**, so a
  `name_taken` / `bad_name` refusal appears next to the field it is about. `expectError` still sees
  it (it stays visible in both gates).
- Focus lands in the gate's field — including when the previous gate has just been hidden and focus
  was on a control that no longer exists. It never steals focus from someone already typing in it,
  and still never pops the mobile keyboard on Home.

**Grace preserved (POKER-006):** a returning browser with a stored name does **not** see the gate
while its silent claim is in flight (`nameIsThePath()` is false), and if that claim never lands the
2.5s stall guard flips `claimRejected`, which raises the gate with the name prefilled. One predicate
drives both the claim form's lifetime (POKER-005) and the gate state, so they cannot disagree.

## 4. Test changes (deliberate)

| Spec | Was | Now |
|---|---|---|
| `vote-identity.spec.ts` AC1/AC5 | unnamed viewer sees the deck with a disabled select + the `need-name` hint | unnamed viewer is at the name gate with votes hidden; **after** claiming, the deck renders exactly as the server owns it and the select is enabled |
| `name-claim.spec.ts` POKER-006 | the unnamed page read its own roster | a **named** member sees the unnamed one as "not named yet" and never a raw session id (the actual guarantee) |
| `live-smoke.spec.ts` | guest's select is disabled | guest is at the name gate, `[data-section="votes"]` hidden |
| `presentation.spec.ts` AC4 | entered a room and asserted votes/history | claims a name first, then asserts the room |
| `rooms.spec.ts` AC4 | read the passcode back right after the passcode retry | claims a name first (a name precedes the room's own controls) |
| `entry.spec.ts` | — | every entry path now asserts the gate, then the room |

The user-facing guarantee "no name, no ballot" is unchanged; the browser-level *disabled select*
assertion moved to the server-side gate (already covered by `test/`), because an unnamed viewer can no
longer reach a ballot control at all.

## 5. Acceptance criteria

- [x] AC1 — link **and** typed code both land an unidentified visitor on the name gate
      (`data-room-state="name"`, gateway visible, votes/members/invite hidden, field focused).
- [x] AC2 — the passcode gate comes first for a protected room; the name gate follows it.
- [x] AC3 — claiming a name flips to `live`, the furniture appears, and the claim form is removed
      from the DOM (POKER-005 intact).
- [x] AC4 — a returning browser is never re-prompted (stored name → silent claim → live), and the
      POKER-006 stall guard still raises the gate with the name prefilled.
- [x] AC5 — `npm test` **122 / 122**; `npm run test:e2e` **39 passed / 3 skipped / 0 failed**.
- [x] AC6 — deployed and verified on the live origin.

## 6. Files

`public/index.html` · `public/app.js` · `public/style.css` · `e2e/entry.spec.ts` ·
`e2e/name-claim.spec.ts` · `e2e/vote-identity.spec.ts` · `e2e/presentation.spec.ts` ·
`e2e/rooms.spec.ts` · `e2e/live-smoke.spec.ts` · this ticket.

## 7. Verification (deployed origin, 2026-09-14)

| Check | Result |
|---|---|
| Local probe (link / typed code / after naming) | `name`, `name`, `live` — votes+invite hidden until named, field focused |
| Live entry checks (temporary probe, test room cleaned up) | see the deploy log: gate on both paths, claim → live |
| `npm run test:e2e:live` (sanctioned smoke) | **3 passed** |
