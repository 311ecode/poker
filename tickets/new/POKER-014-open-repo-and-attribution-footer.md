# POKER-014 — publish the repository and add the attribution footer

**Project:** poker (main) · **Created:** 2026-09-13
**Reporter:** user — *"we should make it an open repository… at the bottom of the page we should have
a link, something like 'brought to you by imre.dev', and a source link."*
**Status:** IN PROGRESS

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

- [ ] AC1 — `https://api.github.com/repos/311ecode/poker` answers `200` **without** authentication
  (i.e. the repo is public) and carries the poker homepage + description.
- [ ] AC2 — `footer.site-footer` renders on both the Home and Room screens with an `imre.dev` link
  and a `source` link to the GitHub repo.
- [ ] AC3 — Both footer links are `target="_blank"` with `rel` containing `noopener`.
- [ ] AC4 — `npm test` + `npm run test:e2e` green; live smoke green; ticket moved to
  `tickets/done/`.

## 2. Files

`public/index.html` (footer), `public/style.css`, `e2e/client-shell.spec.ts`, this ticket. Repo
settings are changed through the GitHub API (not committed).
