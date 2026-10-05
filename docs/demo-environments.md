# Demo environments

> **Also seeded:** **Namokar Eye & Oculoplasty Centre** (pilot; own sign-in page `/login/namokar`, Revenue Tracking off) — a fictional telecalling / front-desk clinic (**Beta V1**, Ophthalmology, Asia/Kolkata) with a realistic *today*: 10 new enquiries, 8 appointments in every queue state, 9 calls (1 missed IVR, 2 not connected), follow-ups due today / overdue / coming up, an Appointment Risk and a Surgery Follow-up. Accounts `namokar.{superadmin,admin,doctor,doctor2,frontdesk,coordinator}@pulseos.local`. Everything is invented. See `apps/api/src/seed/demo/namokar.ts`.

`pnpm db:seed` wipes every tenant and re-creates three fully separate demo tenants:
**PulseOS Gynecology Demo** and **PulseOS Ophthalmology Demo** (both **Beta V2 · Growth** edition), and
**PulseOS Ophthalmology V1 Demo** (**Beta V1 · Core CRM** edition — the same clinic data, with Inbox, Campaigns,
marketing Analytics and spend/ROAS switched off server-side). Accounts: `gyn.<role>@pulseos.local`,
`eye.<role>@pulseos.local` and `eyev1.<role>@pulseos.local` (`superadmin`, `admin`, `doctor`, `doctor2`,
`frontdesk`, `coordinator`), password = local `DEMO_PASSWORD`. With `ENABLE_DEV_LOGIN=true` the login page's
*Developer access* section (development only, loopback only) picks an environment, then a role (Super Admin, Admin, Staff · Front Desk, Staff · Patient
Coordinator, Doctor). The list is **read from the database**: the seeded demos plus every hospital that signed up while
development login was on (`tenant_profiles.dev_visible`), each with only the roles that have an account — a new sign-up
appears with no code change. Roles map to the Beta V1 UX as Super Admin → `SUPER_ADMIN`, Admin → `HOSPITAL_ADMIN`, Staff →
`FRONT_DESK` / `PATIENT_COORDINATOR`; Doctor stays a role and a resource but has no V1 label.

Each demo tenant is built the way a real hospital's would be: the seed runs the same **department template install**
a hospital Admin runs from Settings → Departments (department, services, TEMPLATE fields, treatment catalogue,
lead-source catalogue), so what the demo shows is what a new customer gets.

Layout: `apps/api/src/seed/demo/` — one data file per tenant, row builders in `shared.ts`.
Specialties are plain `SpecialtyTemplate` data (`domain/specialty/*.templates.ts`); no page or
service knows which specialty a tenant runs.

## Seed guarantees

- **Safe to run only on a local PulseOS database** (`seed/safety.ts`): refuses `NODE_ENV=production`,
  a non-local host, or a database not named `pulseos`, `pulseos_<suffix>` (no `prod`/`live`/`staging`).
- **Consistent journeys** (`seed/demo/consistency.ts`): stage must agree with appointment, outcome,
  treatment and contact date; revenue only on COMPLETED treatments. A contradiction aborts the seed.
- **Stable same-day queue** (`seed/demo/demo-clock.ts`): today's appointments are placed relative to a
  clinic-hours "demo now" (real time clamped to 11:00–17:30), so waiting / checked-in / with-doctor /
  completed / upcoming look right whether seeded at 7 am or 9 pm.
- Every missed-call Inbox conversation is backed by a real `calls` row.

## Communication endpoints (limitation)

The Ophthalmology demo has three active Runo phone lines (Main Reception, Cataract Enquiry Line,
Surgery / Procedure Line). Runo's real API does not say which hospital line took a call, so live
inbound webhooks only auto-tag a line when the connector has **exactly one** active endpoint;
with several they stay honestly unresolved (`endpointLabel: null`) — the product never guesses.
The *seeded* fixture calls name their line explicitly because they are hand-written demo data,
not provider events.
