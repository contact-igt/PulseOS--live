# PulseOS — M7 Progress: Full Update & Details

**Module:** M7 — Capabilities + Integration Hub + WhatsApp V1 + Ads Analytics + Runo-inspired CRM / Leads UX
**Prepared for:** Sushil, CEO, Invictus Global Tech
**Date:** 2026-10-02
**Branch:** `claude/wonderful-carson-o7jbjk` · **Pushed HEAD:** `6fb9594` (identical to upstream) · **Start (M6.6):** `3dbd39c`
**Size of change:** 161 files · +64,863 / −829 · 19 commits · 7 new migrations (0027–0033)

---

## 1. Where we are

| Area | State |
|---|---|
| Build waves A–G | **Complete** |
| Final gate (lint, typecheck, API, web, build, Playwright, fresh migrate + seed ×2, V1/V2 smoke, responsive) | **Green** |
| Independent reviews (round 1 + round 2 incl. Opus final) | **Done**, verified findings fixed |
| Pushed to origin | **Yes** — fast-forward, nothing merged/forced/deployed |
| Local servers | API `http://localhost:4310`, web `http://localhost:3310/login` running |
| Next module | **M8** recommended, **not started** |

---

## 2. What was delivered

### 2.1 Capability architecture (Wave A)
- One codebase, one core CRM. **Edition is only a default bundle**; per-tenant overrides (`tenant_capabilities`) are the runtime authority and are enforced in the **backend** on every request.
- Capabilities: `ANALYTICS_CORE` (locked on), `MARKETING_ANALYTICS`, `GOOGLE_ADS`, `META_ADS`, `RUNO_CALLING`, `CCS_IVR`, `WHATSAPP_NOTIFICATIONS`, `WHATSAPP_INBOX`, `CONVERSATION_INTELLIGENCE`, `SMS_NOTIFICATIONS` (+ existing Campaigns, Spend attribution).
- Explicit dependencies: Conversation Intelligence → Inbox; Google/Meta Ads, Campaigns, Spend attribution → Marketing Analytics.
- Who can change what: Super Admin all; Hospital Admin only WhatsApp/SMS notifications; staff/doctor none. Changes are serialized and audited.
- **Enabled ≠ Configured ≠ Healthy ≠ Mode** reported separately everywhere.

| | V1 default | V2 default |
|---|---|---|
| Core CRM + Core Analytics | ON | ON |
| Marketing Analytics | OFF (Super Admin can enable) | ON (can disable) |
| Google / Meta Ads | OFF | configurable |
| WhatsApp Inbox, Conversation Intelligence | OFF | ON |
| Runo, CCS, WhatsApp Notifications, SMS | configurable | configurable |

### 2.2 Integration Hub (Wave B)
- Categories: Overview · Ads & Attribution · Calling & IVR · Messaging · Advanced (Webhooks).
- Cards show provider, purpose, Enabled, Configuration, Health, Mode. Detail tabs: Overview, Configuration, Mappings, Webhooks, Logs, Health, Sync. Credentials Super Admin only; secrets are never returned (only `hasSecret`).
- **Outbound webhooks** (Super Admin only): HMAC-SHA256 signing, idempotent per (webhook, event), 4 attempts with backoff, redirects refused, public-host check at save and delivery, simple field/operator/value AND conditions (no scripting). Disabling a webhook stops queued deliveries.
- **CCS IVR stays BLOCKED** — "Provider API/Webhook documentation required". No invented payloads or auth. **Runo** preserved as the call provider.

### 2.3 WhatsApp Phase 1 + Reminder engine (Wave C)
- Works with **Inbox OFF**: appointment/surgery confirmation and reminders; staff "Send WhatsApp" with preview that never completes the task.
- Pure planner with suppression (trigger passed, too close to previous, cancelled, rule disabled); DB-unique idempotency; worker re-checks the visit before sending; never sends late.
- Safety rules added after review: an ambiguous provider outcome (timeout after send, unreadable 2xx) is **never retried**; a send interrupted mid-flight is marked `SEND_INTERRUPTED`, **never re-sent**; a staff send is never auto-retried.
- Phase 2 (Inbox / Conversation Intelligence) intentionally not expanded.

### 2.4 Ads analytics + date presets (Waves D/E)
- Google Ads and Meta Ads: **read-only** `AdsReportingProvider` adapters → durable sync run → normalized `ads_daily_facts` → Marketing Analytics "Ad accounts". A failed sync keeps the last good data and marks it stale. Meta actions need an explicit mapping before counting as leads.
- Provider conversion ≠ PulseOS appointment; costs/ROAS only with valid denominators; Doctor never sees hospital-wide ad spend.
- **One shared date-preset implementation** (Today, Yesterday, 7D, 9D, 30D, 90D, This Month, Previous Month, Custom), hospital timezone, URL-persisted, used by Analytics, Operations report, Leads and logs. Charts have hover/focus tooltips.

### 2.4b Login / brand (Wave F)
- Logo, small V1/V2 badge, Developer Login dev-only, no fake stats.
- **Remember Me is server-owned:** persistent cookie + 7-day session vs session cookie + 12 h; httpOnly; no token in browser storage; logout invalidates either.
- Nav tooltips only where a label is truncated.

### 2.5 CRM field engine extensions
Extends the existing engine (declarative only — no scripts/BPMN/automation):
- **Required, read-only (set once), filterable, carry-forward** (never outcome, call feedback, dates or status; needs an entry form — enforced on create *and* update).
- **Nested/child fields and conditional show/require** by outcome or option (≤5 rules per field; unknown-option and cycle checks; one shared pure evaluator on server and form; option/type changes that would strand a rule are refused).
- Archive keeps history; "all services" or per-service scope; visibility surfaces; lightweight preview. Outcome events store submitted values as history.

### 2.6 Leads UX
Name/phone search · date presets · result count · owner/source/service/status/CRM-field filters · saved column preference · pagination with rows-per-page · appointment visibility · one **Call** + overflow menu · row click opens the Journey · mobile cards with filters in a SideSheet. The CRM-field filter honours field visibility (a clinical-only field is neither offered nor usable by front desk).

### 2.7 Activity Log
`activity_log` + Settings → Activity (Admin / Super Admin). Records capability changes, integration config and credential *names*, webhooks, ads sync triggers, exports, CRM fields, outcomes, follow-up types, lead sources, reminder rules and templates. Secret-named keys are never stored; text is redacted and bounded; tenant-scoped.

### 2.8 Team Live Status — deferred
Documented as FUTURE CAPABILITY `TEAM_LIVE_STATUS`. Runo sends per-completed-call webhooks with no presence signal, so "on call / idle" would be a guess.

---

## 3. Verification (final tree)

| Check | Result |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Pass |
| API suite | **102 files · 1100 tests pass** (fresh migrated + seeded DB) |
| Web unit / UI package | 167 / 132 tests pass |
| Playwright full run (317) | 307 passed, 9 failed → all fixed (7 legacy screenshot specs on the replaced Integrations page, 1 Leads mobile selector, 1 real 44px tap-target gap); re-run 33/33 |
| M7 e2e repeat **without reseeding** | 20/20, twice |
| Fresh DB: all 34 migrations, seed ×2 | Row counts identical (tenants 3, patients 98, journeys 100, tasks 65); final clean reseed matches |
| V1 smoke (`eyev1.admin`) | Core 200 · marketing analytics/ads 403 |
| V2 smoke (`eye.admin`) | Core, marketing, ads, hub, leads all 200 |
| Responsive sweep 1440×900 / 1280×800 / 1024×768 / 768×1024 / 390×844 | No horizontal overflow, no error overlay (Login, Leads, Hub, Settings Features/Reminders, Core + Marketing Analytics, My Work) |

## 4. Reviews and fixes

- **Round 1 (R1–R9):** webhook SSRF/redirect, tenant-scoped delivery status, no double send, ads robustness, capability transaction — fixed earlier.
- **Round 2 (R8/R10 + security; final independent Opus):** fixed and tested — Leads filter field visibility, carry-forward/rule checks on update, stuck-send resend, ambiguous-send retry, disabled-webhook delivery, staff-send retry key, Runo "IVR" origin label.

## 5. Remaining risks (top items)

1. **No event outbox.** Reminders/webhooks are triggered from in-memory post-commit handlers; a crash loses that event. Fix: outbox row in the same transaction, or a periodic idempotent re-plan.
2. **DNS rebinding** can bypass the webhook public-host check (resolve-then-fetch). Mitigated by Super-Admin-only webhooks; fix with a pinned-address agent.
3. An interrupted reminder is failed visibly rather than retried (deliberate: no duplicates).
4. Appointment/Treatment CRM field placements are stored but not rendered on any screen yet.
5. SMS and CCS IVR are switches without a backend consumer (no provider / no documentation).
6. Leads column preference is per-browser; custom range is day-level only.
7. Google/Meta live and WhatsApp live paths verified with fixtures only — not against real providers.
8. e2e runs share the dev DB; reseed afterwards.

## 6. Recommended next module

**M8 — event outbox + periodic re-plan, and webhook DNS pinning.** Closes risks 1–2 before any live provider is switched on. *Not started.*

## 7. Demo access (local only)

Password = local `DEMO_PASSWORD`. Ophthalmology V1: `eyev1.admin@`, `eyev1.frontdesk@`… · Ophthalmology V2: `eye.admin@`, `eye.doctor@`, `eye.frontdesk@`, `eye.coordinator@` · Gynecology: `gyn.admin@` … (all `@pulseos.local`; every tenant has `*.superadmin@`).

## 8. Where the details live in the repo

- `docs/reports/PULSEOS_M7_FINAL_INTEGRATIONS_CRM_UX_REPORT.md` — the formal final report (all required headings)
- `docs/m7-capabilities-integrations.md` — architecture overview and deferred items
