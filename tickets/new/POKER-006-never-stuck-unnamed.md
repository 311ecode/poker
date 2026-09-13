# POKER-006 — an unnamed visitor can always claim, and never shows as a raw UUID

**Project:** poker (this repo, `main`) · **Created:** 2026-09-13
**Reporter:** user — after a reload during a deploy window the room showed *"You are (…)"* empty, the
member row showed `s-b0d5b3ee-… (online)` instead of a name, and the claim form was present but
hidden, so there was no way to claim. *"it's not my name… I've created it."*
**Status:** IN PROGRESS

## 0. Root cause

Their page had the **POKER-005 `index.html`** (`data-claim-slot`) but an **older `app.js`**: the form
was `hidden` but not detached. The mix comes from reloading during a `git pull` window on g2, where
`index.html` lands before `app.js`. A reload fixes that instance.

But the state it exposed was possible in principle: the claim form's visibility depended on a
*silent* auto-claim landing. If that claim was lost or refused with a code outside the small
`name_*` set, the visitor stayed unnamed with the form hidden — no way forward. That is the real bug
this ticket closes.

## 1. Decision

1. **Never stuck.** While in a room and unnamed, any refusal other than "you are not in this room"
   (`bad_passcode` / `bad_room` / `bad_session` / `not_in_room`) reveals the claim form.
2. **Stall guard.** If the silent auto-claim has not named the session within ~2.5 s, the claim form
   appears anyway (prefilled with the stored name) instead of leaving the room unnamed.
3. **No raw UUID.** An unnamed member renders as `not named yet`, never as their session id. The
   `data-member-name` hook still carries the raw (empty) name.
4. Nothing about the POKER-002/003/004/005 contract changes: name still mandatory, permanent,
   browser-bound; deck still a select sent on change.

## 2. Acceptance criteria

- [ ] AC1 — An unnamed member row reads "not named yet (online)" and never contains `s-…`.
- [ ] AC2 — A stored name that this room refuses (taken) shows the error **and** the claim form,
  prefilled with the stored name.
- [ ] AC3 — If the silent claim frame is swallowed (never reaches the server), the claim form still
  appears within the stall window, so the visitor can claim manually.
- [ ] AC4 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to `tickets/done/`.

## 3. Files

`public/app.js` (`renderMembers`, the error fallback, the stall timer in `autoClaimStoredName`),
`e2e/name-claim.spec.ts` (three new proofs), this ticket.
