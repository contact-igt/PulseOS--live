# PULSEOS — M7 FINAL INTEGRATIONS + CRM UX REPORT

## STATUS
**GREEN with documented limitations.** Every gate below passed on the final tree. Items that cannot be real yet (CCS IVR, SMS, Team Live Status, Phase 2 WhatsApp) are documented, not faked.

## GIT
- Branch: `claude/wonderful-carson-o7jbjk`
- Starting HEAD (M6.6 checkpoint): `3dbd39c`
- Final HEAD / push status / upstream / working tree: see the closing message of the session (they change when this report is committed and pushed).

## CAPABILITY ARCHITECTURE
Edition is only the default bundle; `tenant_capabilities` overrides are the runtime authority, resolved on every request into the session map. Backend `requireCapability` guards every gated route; webhooks/jobs use `tenantCapabilityMap`. Explicit dependencies (Conversation Intelligence → Inbox; Google/Meta Ads, Campaigns, Spend attribution → Marketing Analytics). `ANALYTICS_CORE` is locked on. Admin edits only WhatsApp/SMS notifications; Super Admin edits all; changes are serialized (row lock) and audited. Enabled ≠ Configured ≠ Healthy ≠ Mode throughout.

## V1
Core CRM + Core Analytics. Marketing Analytics, Google/Meta Ads, Inbox, Conversation Intelligence OFF by default; Runo, WhatsApp Notifications, SMS configurable. Marketing is Super-Admin-enableable.

## V2
Core CRM + Core Analytics + Marketing Analytics + Inbox + Conversation Intelligence ON by default; ads/Runo/CCS/WhatsApp Notifications/SMS configurable; Marketing disableable (dependants first).

## FEATURE SETTINGS
Settings → Features (Super Admin all, Admin only notification switches), with dependency reasons and "Set up in Integration Hub" links. 44px tap targets on mobile.

## VERSION BADGE / LOGIN / REMEMBER ME
Small V1/V2 badge, logo, Developer Login dev-only, no fake stats. Remember Me is server-owned: persistent cookie + 7-day session vs session cookie + 12 h; httpOnly; no token in browser storage; logout invalidates either; dev login always non-persistent.

## INTEGRATION HUB
Overview, Ads & Attribution (Google, Meta), Calling & IVR (Runo, CCS), Messaging (WhatsApp, SMS), Advanced (Webhooks). Cards show provider, purpose, Enabled, Configuration, Health, Mode. Detail: Overview/Configuration/Mappings/Webhooks/Logs/Health/Sync; credentials Super Admin only; secrets never returned (`hasSecret` only). Old connector workbench still at `/integrations?view=connectors`.
Outbound webhooks (Super Admin only): HMAC-SHA256 over `timestamp.body`, idempotent per (webhook, event), 4 attempts with backoff, redirects refused, public-host check at save and delivery, simple AND conditions, no scripting; disabling a webhook stops queued deliveries.

## RUNO
Preserved as the call provider; gated by `RUNO_CALLING`; public call events no longer carry an IVR origin.

## CCS IVR
BLOCKED — "Provider API/Webhook documentation required". Nothing invented. Configuration requests return 409.

## GOOGLE ADS / META ADS
Read-only `AdsReportingProvider` adapters (fixture + read-only live GET) → durable sync run → normalized `ads_daily_facts` (window replaced transactionally) → Marketing Analytics "Ad accounts". A failed sync keeps the last good data and marks it stale. Meta actions need an explicit mapping before being called leads. Provider conversions are never presented as PulseOS appointments; costs/ROAS only with valid denominators.

## WHATSAPP PHASE 1
`WHATSAPP_NOTIFICATIONS` works with Inbox OFF: appointment/surgery confirmation and reminders, staff "Send WhatsApp" with preview that never completes the task and is never auto-retried. Delivery statuses move forward only.

## WHATSAPP PHASE 2
Not expanded in M7 (Inbox / Conversation Intelligence existing behaviour only, capability-gated).

## REMINDER ENGINE
Pure planner (suppression: trigger passed, too close to previous, cancelled, rule disabled), DB-unique idempotency key, worker re-checks the visit before sending, never sends late. Ambiguous provider outcomes (timeout after send, unreadable 2xx) are never retried; a send interrupted mid-flight is marked `SEND_INTERRUPTED`, never re-sent.

## CRM CONFIGURATION
Extends the existing field engine: required, read-only (set once), filterable, carry-forward (never outcome/call feedback/dates/status; needs an entry form — enforced on create and update), nested/child fields and conditional show/require by outcome or option (declarative, ≤5 rules, cycle/unknown-option checks, shared pure evaluator on server and form, refusing option/type changes that would strand a rule), archive keeps history, "*" (all services) or per-service scope, visibility surfaces, lightweight preview. Outcome events store the values as history.

## LEADS UX
Name/phone search, date presets, result count, owner/source/service/status/CRM-field filters, saved column preference, pagination with rows-per-page, appointment visibility, one Call + overflow menu, row click opens the Journey, mobile cards with filters in a SideSheet. Field filter honours field visibility (a clinical-only field is neither offered nor usable by front desk). Custom range is date-level only (no sub-day range: no report needs it).

## TEAM LIVE STATUS
**Deferred — FUTURE CAPABILITY `TEAM_LIVE_STATUS`.** Evidence: Runo webhooks arrive per completed call; there is no presence signal, so "on call/idle" would be a guess. See `docs/m7-capabilities-integrations.md`.

## ACTIVITY LOG
Implemented (`activity_log`, Settings → Activity, Admin/Super Admin): capability changes, integration config/credential names, webhooks, ads sync triggers, exports, CRM fields, outcomes, follow-up types, lead sources, reminder rules/templates. Secret-named keys are never stored, text redacted, metadata bounded; tenant-scoped.

## CORE ANALYTICS
On in both editions; operations report and summary share one preset resolver.

## MARKETING ANALYTICS
Capability-gated in the backend (403 in V1 default, 200 in V2); ad accounts tab with hover/focus tooltips; never shown to Doctor.

## DATE FILTERS
Today, Yesterday, 7D, 9D, 30D, 90D, This Month, Previous Month, Custom — one `resolveDatePreset` in `@pulseos/types`, one `PeriodControls`, hospital timezone, URL persisted (legacy `14d`/`last_month` still accepted).

## ROLE ACCESS
Doctor has no marketing/revenue access (all `/analytics/*` refused). Staff/Doctor cannot change capabilities or CRM fields. Webhooks/credentials Super Admin only.

## SECURITY
Tenant id only from session; secrets never returned or logged; webhook SSRF checks (see risk 2); HMAC signing; httpOnly cookies; field filter SQL parameterized and visibility-scoped; fixture-only tests.

## RESPONSIVE / ACCESSIBILITY
Sweep at 1440×900, 1280×800, 1024×768, 768×1024, 390×844 over Login, Leads, Integration Hub, Settings Features/Reminders, Core + Marketing Analytics, My Work: no horizontal overflow, no Next.js error overlay. Settings controls meet 44px at 390px. Status is text + colour; nav tooltips only for truncated labels.

## TEST RESULTS
- Lint: pass. Typecheck: pass (7/7).
- API: 102 files / 1100 tests pass (on a freshly migrated + seeded DB).
- Web/UI: web 28 files / 167 tests; ui 16 files / 132 tests pass.
- Build: pass.
- Playwright (full, 317 tests): 307 passed, 9 failed → 7 legacy screenshot specs pointed at the replaced Integrations page, 1 Leads mobile selector, 1 genuine 44px tap-target gap in the new Settings controls. All fixed; the 9 re-run green together with their neighbours (33 passed).
- No-reseed repeat: M7 e2e (20 tests) run twice back to back without reseeding — 20/20 both times.
- Fresh migration: schema dropped, all 34 migrations applied cleanly.
- Seed run 1 / run 2: identical row counts (tenants 3, patients 98, journeys 100, tasks 65); final clean reseed matches.
- V1 smoke (`eyev1.admin`): operations report 200, marketing analytics/ads 403, hub 200, leads 200.
- V2 smoke (`eye.admin`): operations, marketing analytics, ads, hub, leads all 200.
- Note: one API test (Runo missed-call) is sensitive to leftover tasks from the Playwright run on the shared dev DB; it now selects its own task. Reseed after e2e runs.

## REVIEW AGENTS
Round 1 (R1–R9) fixes landed earlier (webhook SSRF/redirect, tenant-scoped delivery status, no double send, ads robustness, capability transaction). Round 2: R8/R10 + security re-check (2 Important, 2 Minor) and the final independent Opus review (5 Important, 3 Minor). Fixed and tested: field filter visibility; carry-forward/rules on update; stuck-PROCESSING resend; ambiguous-send retry; disabled webhook still delivering; failed staff send retry key; Runo "IVR" origin label. Not fixed — see risks.

## FILES / MIGRATIONS CHANGED
160 files since `3dbd39c`. Migrations 0027 tenant_capabilities, 0028 outbound_webhooks, 0029 notifications, 0030 ads_facts, 0031 notifications_cascade, 0032 activity_log, 0033 crm_field_behaviour.

## PROVIDER LIMITATIONS
CCS IVR blocked (no documentation). SMS has no provider. Google/Meta live mode is read-only and needs real credentials to exercise; verified with fixtures. WhatsApp live send needs an approved template and credentials.

## REMAINING RISKS
1. **No outbox for domain events.** Reminders/webhooks are triggered from in-memory post-commit handlers; a crash or transient DB error loses that event. `planForSubject` is idempotent, so a periodic re-plan job is the fix.
2. **DNS rebinding** can bypass the webhook public-host check (resolve-then-fetch). Mitigated by Super-Admin-only webhooks; fix with a pinned-address undici agent.
3. A reminder interrupted mid-send is failed (visible), not retried — deliberate, favours no duplicates over delivery.
4. Delivery-status-before-message-id race and a late "delivered" after FAILED remain small gaps.
5. Appointment/Treatment CRM field placements are stored but not rendered anywhere yet.
6. Leads column preference is per-browser, not server-side.
7. SMS and CCS capabilities are switches without a backend consumer.
8. e2e runs share the dev database; reseed after them.
9. Leads has no sub-day custom range.
10. Live Ads/WhatsApp paths are unverified against real providers.

## NEXT MODULE
**M8 — event outbox + periodic re-plan, and webhook DNS pinning** (closes risks 1–2 before any live provider is switched on). Not started.
