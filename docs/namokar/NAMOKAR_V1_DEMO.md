# Namokar V1 — DEMO / TEST DATA

**Purpose:** training, demonstrations and trying the workflow safely. **Everything in it is fictional.** Do not enter real patients here.

| | |
|---|---|
| **Sign-in** | `/login/namokar-v1` (the older address `/login/namokar` redirects here). |
| **Label** | Namokar · V1 Demo |
| **Data** | A realistic fictional clinic day: new and uncontacted enquiries, manual and IVR-fixture calls with feedback, callbacks due and overdue, appointments booked and confirmed, a WhatsApp confirmation (fixture) and a 1-hour reminder, patients checked in / waiting / with the doctor, a completed consultation, follow-up and procedure advised and scheduled, a no-show, a not-interested enquiry. A few items are deliberately **Unassigned**. |
| **Team** | Front Desk, Shivani and Sushil (Patient Coordinators), and Dr. Poonam Jain. Work is spread across the three telecallers. |
| **Providers** | Runo and WhatsApp are **FIXTURE** (nothing real is called or sent). Meta, Google and CCS are not configured. |
| **Revenue** | Off. |

Accounts (`namokar.frontdesk`, `namokar.coordinator` (Shivani), `namokar.coordinator2` (Sushil), `namokar.doctor`, `namokar.admin`, `namokar.superadmin` `@pulseos.local`) use the local `DEMO_PASSWORD`; no password is stored in the repository.

The demo is rebuilt by the local seed (`pnpm db:seed`), which **deletes every workspace** and recreates both Namokar workspaces — it refuses to run on a non-local database. Never point it at the real pilot's database.
