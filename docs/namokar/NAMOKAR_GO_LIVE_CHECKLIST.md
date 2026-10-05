# Go-live checklist (before staff start)

The demo workspace (fictional patients, fixture providers) and the real workspace must stay separate. **Never run `pnpm db:seed` against a real database: it deletes every hospital** (it refuses to run on a non-local database or in production, by design).

**The two workspaces:** *V1 Demo* (`/login/namokar-v1`) holds fictional data for training. *V2 Pilot* (`/login/namokar-v2`) is the clean workspace for real entry — it already exists in the local build with configuration only (see [NAMOKAR_V2_PILOT.md](NAMOKAR_V2_PILOT.md)). On a real server, create it with steps A and B below (the seed is local-only), then confirm the **clinic hours** (Mon–Sat 09:00–16:00, Sunday closed, Asia/Kolkata) with Namokar and set them as an administrator: `PUT /clinic-hours` with `{ "clinicHours": { "mon": ["09:00","16:00"], "tue": ["09:00","16:00"], "wed": ["09:00","16:00"], "thu": ["09:00","16:00"], "fri": ["09:00","16:00"], "sat": ["09:00","16:00"], "sun": null } }` (send `null` to remove the restriction). Until hours are set, any time is accepted.

## A. Create the real workspace (once, by the administrator)
1. **Sign up the hospital** at `/signup` (Healthcare → Eye / Ophthalmology, edition V1). This creates a *new, empty* Namokar workspace with its own sign-in page `/login/<name>`, one branch, and the owner account (Super Admin) with the owner's own password. The demo workspace is untouched.
2. **Turn Revenue Tracking off** (a new V1 workspace has it on): as the owner, `PUT /capabilities/REVENUE_TRACKING` with `{ "enabled": false }`, or the **Settings → Features** switch. WhatsApp Inbox is off in V1 by default; WhatsApp Notifications is on.
3. **Reminders:** Settings → Reminders → keep *Confirmation* and the *1 hour before* reminder on; switch the *1 day before* reminder off.
4. **Branch:** name the one branch (Ashok Vihar). Do not add a second one: the forms hide the branch only while there is exactly one.

## B. Real accounts (the administrator, one command per person)
The product has no staff screen yet. Run this once per person on the server (the password is read from the environment, never typed on the command line, and is shared with the person privately):

    STAFF_PASSWORD='<a long password>' pnpm --filter @pulseos/api staff:add -- \
      --hospital <login slug> --role FRONT_DESK --name "Receptionist name" --email name@clinic.example

Roles: `FRONT_DESK` (Receptionist), `PATIENT_COORDINATOR` (run twice: Shivani and Sushil; "Special Coordinator" is only a job title and has no separate role), `DOCTOR` (Dr. Poonam Jain — she becomes the clinic's only doctor automatically), `HOSPITAL_ADMIN`. The owner is the sign-up account. No demo password, no shared logins. Each person should change their password after the first sign-in.

**Owner and Admin accounts.** The local V2 workspace has two placeholder accounts, *Namokar Owner (placeholder)* and *Namokar Admin (placeholder)*, so someone can reach Settings. On a real server, the owner is the sign-up account (its own name and password) and an Admin is created with `--role HOSPITAL_ADMIN`; use the real person's name. Do not use the local demo password anywhere real; Sushil's "Special Coordinator" is a job title only (PulseOS stores no title and has no separate role).

## C. Connections (only with the hospital's own credentials)
5. **WhatsApp Business:** Integrations → WhatsApp: the business account, approved templates, access token. Send one real test confirmation to a staff phone. Until then messages show as fixture/blocked.
6. **Runo (calls):** Integrations → Runo credentials and webhook; place one test call; check the recording is visible to Owner/Admin only. Until then use **Log call**.
7. **Website form:** set the intake token (a long random value, never in the web page) as described in [NAMOKAR_WEBSITE_INTAKE.md](NAMOKAR_WEBSITE_INTAKE.md): `PATCH /connectors/<id>` with `{ "secrets": { "intakeToken": "<value>" } }` (Super Admin only). Give the value only to the web team's server.

## D. Day one
8. 30-minute walkthrough of [the daily routine](NAMOKAR_DAILY_SOP.md): Add Lead → Log call → Callback or Book → **Confirm** → Check-in → outcome. The owner opens *Command Centre → Performance* twice in week one.

## Telling demo from real
Demo patients are the fictional names in the demo workspace only; the real workspace starts empty, so nothing needs deleting there. If a demo workspace is ever shown to staff for training, keep it on its own sign-in page (`/login/namokar`) and tell them it is practice data.

## Deployment status (honest)
There is no deployment target in this repository today: no CI pipeline, no hosting configuration and no deployment document, and the project rules say PulseOS is hosted locally unless a target is explicitly approved. So the verified build is **READY TO DEPLOY — TARGET REQUIRED**. Before deploying, someone must choose and approve: where the web app and API run, which PostgreSQL database holds the real V2 workspace (never the demo database; `pnpm db:seed` must never touch it), the secrets (`SESSION_SECRET`, `CONNECTOR_ENCRYPTION_KEY`, `DATABASE_URL`) and `ENABLE_DEV_LOGIN` left **off**.
