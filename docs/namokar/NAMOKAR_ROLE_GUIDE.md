# Who can do what

All roles are scoped to one Namokar workspace only (V1 Demo or V2 Pilot — an account of one cannot open the other). There is no platform-wide account.

**The team:** *Front Desk* = Front Desk role; *Shivani* and *Sushil* = Patient Coordinator role (the same permissions — there is no separate "special coordinator" role); *Dr. Poonam Jain* = Doctor. Whoever is looking after a patient is the **Assigned Team Member**; a patient may be Unassigned.

| | Super Admin (owner) | Admin | Front Desk | Coordinator | Doctor |
|---|---|---|---|---|---|
| Lands on | Command Centre → **Performance** | Command Centre → **Performance** | **Front Desk** | **My Work** | **Doctor Home** |
| Add / manage leads, log calls, follow-ups | ✔ | ✔ | ✔ | ✔ | — |
| Book / confirm / reschedule / cancel / no-show | ✔ | ✔ | ✔ | ✔ | — |
| Check in → Waiting → Send to doctor | ✔ | ✔ | ✔ | ✔ | — |
| Complete a consultation | ✔ | ✔ | ✔ | ✔ | ✔ **own patients only** |
| Record the treatment outcome | ✔ | — | — | — | ✔ **own patients only** |
| Schedule a procedure | ✔ | ✔ | — | ✔ | — |
| See treatments | ✔ | ✔ | — | ✔ | ✔ (inside Doctor Home) |
| Performance view (funnel, drop-offs, team) | ✔ | ✔ | — | — | — |
| Operations report / Excel export | ✔ | ✔ | — | — | — |
| Call recordings / transcripts | ✔ | ✔ | — | — | — |
| Integrations (secrets) / Settings | ✔ | Admin: config, not secrets | — | — | — |
| Change hospital switches (capabilities) | ✔ | only WhatsApp notifications | — | — | — |
| Revenue / ROAS | **Off for Namokar** | | | | |

Rules the system enforces on the server, not just in the screens: a Doctor can record an outcome or complete a visit **only for the visit that is with them**; Front Desk cannot record a clinical outcome; an Admin cannot turn Revenue back on.
