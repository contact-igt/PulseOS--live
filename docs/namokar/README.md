# Namokar Eye & Oculoplasty Centre — PulseOS V1 Pilot

| | |
|---|---|
| **Two workspaces** | **V1 = DEMO / TEST DATA** at `/login/namokar-v1` ([details](NAMOKAR_V1_DEMO.md)). **V2 = CLEAN PILOT, real entry** at `/login/namokar-v2` ([details](NAMOKAR_V2_PILOT.md)). Same app, separate workspaces, never mixed. The older `/login/namokar` redirects to V1. Each uses the standard branded login ([architecture](../tenant-branded-login.md)). |
| **Team** | Front Desk, **Shivani**, **Sushil** (Patient Coordinators) share the phones; **Dr. Poonam Jain** is the only doctor. Whoever handles a patient is shown as the **Assigned Team Member**. |
| **Clinic hours** | Mon–Sat 09:00–16:00, Sunday closed (Asia/Kolkata) — a workspace setting; confirm with Namokar before launch. |
| **Revenue** | **DISABLED** in both workspaces (capability `REVENUE_TRACKING` is off by the hospital's own setting; nothing is deleted for other hospitals) |
| **Runo (calls)** | V1: **FIXTURE** (nothing real is contacted). V2: **Not configured**. Manual call logging works today. Live Runo needs the hospital's Runo credentials in Integrations. |
| **WhatsApp notifications** | V1: **FIXTURE** (confirmations are recorded, not sent). V2: **Not configured**. Live sending needs the hospital's WhatsApp Business details in Integrations. WhatsApp Inbox and Conversation Intelligence are **off**. |
| **CCS IVR** | **Not configured** (needs the provider's documentation). |
| **Meta / Google lead ingestion** | **Not configured live.** Leads from ads are entered by hand (source *Google*, *Instagram*, *Facebook*…) until a connector is set up. |
| **Website "I am interested" form** | Protected endpoint ready; needs the website to post to it — see [NAMOKAR_WEBSITE_INTAKE.md](NAMOKAR_WEBSITE_INTAKE.md). |

## The pilot shape

One clinic (Ashok Vihar, New Delhi), one doctor (Dr. Poonam Jain), and **three people who share the phones**: the Receptionist and two Patient Coordinators. Because there is exactly one branch and one doctor, PulseOS **does not ask** for either: the Add Lead, Book Appointment and surgery forms pick them automatically and the Branch / Doctor filters are hidden. (The rule is generic — any hospital with exactly one branch or one doctor gets the same simpler screens; a hospital with several still sees the choosers.)

## Read these

0. [NAMOKAR_V1_DEMO.md](NAMOKAR_V1_DEMO.md) and [NAMOKAR_V2_PILOT.md](NAMOKAR_V2_PILOT.md) — which workspace is which.
1. [NAMOKAR_PILOT_QUICK_START.md](NAMOKAR_PILOT_QUICK_START.md) — two pages, for the team.
2. [NAMOKAR_DAILY_SOP.md](NAMOKAR_DAILY_SOP.md) — what each person does each day.
3. [NAMOKAR_ROLE_GUIDE.md](NAMOKAR_ROLE_GUIDE.md) — who can do what.
4. [NAMOKAR_PILOT_WORKFLOW.md](NAMOKAR_PILOT_WORKFLOW.md) — the patient path, with diagrams.
5. [NAMOKAR_ROUTING_MODEL.md](NAMOKAR_ROUTING_MODEL.md) — the screens, the URLs and the breadcrumb.
6. [NAMOKAR_WEBSITE_INTAKE.md](NAMOKAR_WEBSITE_INTAKE.md) — the website form contract.
7. [NAMOKAR_DECISIONS_AND_SECURITY.md](NAMOKAR_DECISIONS_AND_SECURITY.md) — why things are the way they are.
8. [NAMOKAR_INTEGRATION_STATUS.md](NAMOKAR_INTEGRATION_STATUS.md) — what is live, fixture or not configured, per provider.
9. [NAMOKAR_NOTIFICATION_RELIABILITY.md](NAMOKAR_NOTIFICATION_RELIABILITY.md) — when WhatsApp messages are sent and how none are lost.
10. [NAMOKAR_GO_LIVE_CHECKLIST.md](NAMOKAR_GO_LIVE_CHECKLIST.md) — the steps before staff start.

## What the pilot proves

One continuous journey per enquiry: **enquiry → contact → appointment → arrival → consultation → treatment outcome → follow-up / procedure**, with the original source kept all the way, and a simple performance view for the owner (funnel, drop-offs, source, team). It is **not** an EMR: no prescriptions, diagnosis, medications, reports or clinical notes are stored.

## Accounts (local / demo only)

**V1 Demo** accounts: `namokar.superadmin`, `namokar.admin`, `namokar.frontdesk` (Front Desk), `namokar.coordinator` (Shivani), `namokar.coordinator2` (Sushil), `namokar.doctor` (Dr. Poonam Jain) `@pulseos.local`. **V2 Pilot** accounts: `namokarv2.superadmin`, `.admin`, `.frontdesk`, `.shivani`, `.sushil`, `.doctor` `@pulseos.local`. The demo password is the `DEMO_PASSWORD` of the environment it was seeded in; it is **never** shown in the product. All data is fictional.
