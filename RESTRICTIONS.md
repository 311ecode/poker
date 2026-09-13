# Restrictions — what SSPL-1.0 allows here, in plain English

**This file is a summary for humans. It is not the license and it grants nothing.**
The binding terms are in [`LICENSE`](LICENSE) — read it, and note that it may not be modified.
If this page and the license ever disagree, the license wins.

Copyright © 2026 Imre Toth <tothimre@gmail.com> · SPDX: `SSPL-1.0`

## What you may do

| You want to… | Allowed? |
|---|---|
| Read, study, and modify the code | **Yes** |
| Run it for yourself, at home, for your own poker nights | **Yes** |
| Run it **inside your company or organization** (internal use, any number of users) | **Yes** |
| Self-host it for your team, club, or friends on your own infrastructure | **Yes** |
| Redistribute it, modified or not, with the license and notices intact | **Yes** |
| Combine it with other software, as long as you don't trigger the clause below | **Yes** |

Nothing above requires you to publish anything. Internal use is not "offering a service" — the
license's own §2 says you may "make, run and propagate covered works that you do not convey,
without conditions."

## The one thing that changes everything

**If you make the functionality available to third parties as a service, you must release the
entire service stack** — not just this code — under the SSPL, available to everyone by network
download at no charge. That is §13, "Offering the Program as a Service".

"Service source code" is defined broadly on purpose: this code **plus the corresponding source for
all programs you use to make it available as a service**, "including, without limitation,
management software, user interfaces, application program interfaces, automation software,
monitoring software, backup software, storage software and hosting software" — everything needed
for a user to run an instance of the service themselves.

| Someone else wants to… | Allowed? |
|---|---|
| Host it and offer it to third parties as a service | **Only with the whole stack released under the SSPL** |
| Wrap it in a paid product for external customers | **Only with the whole stack released under the SSPL** |
| Take it closed and run it as their own hosted offering | **No** |

## The short version

> **Use it, modify it, run it, share it. Just don't offer it to third parties as a service
> unless you open-source the entire stack you run it on.**

## Why this license

This is an explicitly aggressive license, chosen on purpose. It is **not** an OSI-approved open
source license, and some organizations (and Linux distributions) refuse software under it as a
matter of policy — that trade-off was made knowingly. It exists to keep the software's
functionality available to people and organizations while preventing a third party from turning
it into a closed competing service.

Running `poker.imre.dev` itself is the copyright holder's own use and is unaffected.
