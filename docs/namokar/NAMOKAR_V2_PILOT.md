# Namokar V2 — CLEAN PILOT (real entry)

**Purpose:** the workspace the Namokar team really uses. It starts **empty**: no patients, enquiries, calls, tasks, appointments, treatments, notifications or revenue — only configuration.

| | |
|---|---|
| **Sign-in** | `/login/namokar-v2` |
| **Label** | Namokar · V2 Pilot |
| **Clinic** | One branch: Namokar Eye & Oculoplasty Centre, Ashok Vihar, New Delhi. One doctor: Dr. Poonam Jain. |
| **Team** | Front Desk (receptionist / telecaller), **Shivani** and **Sushil** (Patient Coordinators), Dr. Poonam Jain (Doctor), plus two clearly-labelled placeholder accounts (*Namokar Owner (placeholder)* and *Namokar Admin (placeholder)*) to be replaced with the real owner and admin. If another person joins, add them (see the go-live checklist) — no placeholder people are created. |
| **Clinic hours** | Monday–Saturday 09:00–16:00, Sunday closed, Asia/Kolkata. These are settings of the workspace (not code); **confirm with Namokar before launch, and whenever the clinic hours change.** |
| **Appointments** | Only accepted inside clinic hours. The server refuses a Sunday or an out-of-hours time even if a screen is bypassed. The doctor and branch are filled in automatically. |
| **Configuration present** | Ophthalmology services and CRM fields, call outcomes, follow-up types, the reminder rule (Confirmation + one reminder 1 hour before; the 1-day reminder is off), Revenue Tracking **off**. |
| **Providers** | **Nothing is connected.** Runo, WhatsApp, the website form, Meta, Google and CCS all read **Not configured** until the hospital's own credentials are added. **Log call** and **Add Lead** work without any of them. |

## First day
The Command Centre of an empty workspace shows *Your workspace is ready* with next steps: Add first Lead, Review CRM Fields, check appointment settings, connect calling, configure WhatsApp. No numbers are shown until there is real work.

## Passwords
Never in Git. On a server, create each person with `staff:add` (see the [go-live checklist](NAMOKAR_GO_LIVE_CHECKLIST.md)); locally the seed gives the V2 accounts the local `DEMO_PASSWORD` for testing only.

## Keeping it clean
Test with the V1 Demo, not here. If a test record is ever created here, remove only that record; the workspace should return to zero patients.
