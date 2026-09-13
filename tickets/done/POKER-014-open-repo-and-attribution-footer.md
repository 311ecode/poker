# POKER-014 — publish the repository and add the attribution footer

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"we should make it an open repository… at the bottom of the page we should have
a link, something like 'brought to you by imre.dev', and a source link."*
**Status:** **DONE** (2026-09-13) — footer landed on `main` (`ebf0eff`) and deployed; the repository
is **public** with homepage `https://poker.imre.dev`.

## 0. Decisions

1. **`github.com/311ecode/poker` becomes public.** The project is **SSPL-1.0** by design (source
   available; offering it as a service obliges releasing the stack) and the history is clean — a
   full-history scan found no tokens, keys or credentials, and the only secret-ish match
   (`systemd/poker-cloudflared.service`) merely *references* a gitignored token file. The repo also
   gets a homepage (`https://poker.imre.dev`) and a description.
   `LICENSE` stays verbatim; nothing about the licence changes.
2. **A footer on every screen**, below `<main>` so it shows on both the Home and Room panels:
   `brought to you by imre.dev · source`, linking to `https://imre.dev` (the owner's portfolio) and
   `https://github.com/311ecode/poker`. External links open in a new tab with
   `rel="noopener noreferrer"`.

## 1. Acceptance criteria

- [x] AC1 — `https://api.github.com/repos/311ecode/poker` answers `200` **without** authentication
  (i.e. the repo is public) and carries the poker homepage + description.
- [x] AC2 — `footer.site-footer` renders on both the Home and Room screens with an `imre.dev` link
  and a `source` link to the GitHub repo.
- [x] AC3 — Both footer links are `target="_blank"` with `rel` containing `noopener`.
- [x] AC4 — `npm test` green (117/117), `npm run test:e2e` green (28 passed, 3 live gated),
  `LIVE=1 npm run test:e2e:live` green (3/3, zero test residue) on the origin; ticket moved to
  `tickets/done/`.

## 3. Repo settings applied (not in git)

`PATCH /repos/311ecode/poker` → `private: false`, `homepage: https://poker.imre.dev`,
`description: "No-auth realtime planning-poker voting rooms — SSPL-1.0"`. Verified anonymously
afterwards: API `200`, `private: false`, homepage set, and `https://github.com/311ecode/poker`
returns `200`. A full-history scan for credentials was run before publishing: clean.

## 2. Files

`public/index.html` (footer), `public/style.css`, `e2e/client-shell.spec.ts`, this ticket. Repo
settings are changed through the GitHub API (not committed).
