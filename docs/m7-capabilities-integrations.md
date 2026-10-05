# M7 — capabilities, Integration Hub, WhatsApp notifications, ads analytics

One codebase, one core CRM. **Edition is only the default bundle of capabilities**; `tenant_capabilities` rows
(a Super Admin's overrides) are the runtime authority. There is no `if edition === "V1"` fork anywhere: UI and API both
read the tenant's *resolved* capability map (`packages/types` → `resolveCapabilities`, session `capabilities`).

## Capabilities

`ANALYTICS_CORE` (locked on), `MARKETING_ANALYTICS`, `GOOGLE_ADS`, `META_ADS`, `RUNO_CALLING`, `CCS_IVR`,
`WHATSAPP_NOTIFICATIONS`, `WHATSAPP_INBOX`, `CONVERSATION_INTELLIGENCE`, `SMS_NOTIFICATIONS` (+ the existing `CAMPAIGNS`,
`SPEND_ATTRIBUTION`). Dependencies are explicit (`CAPABILITY_DEPENDENCIES`): Conversation Intelligence → Inbox;
Google/Meta Ads, Campaigns, Spend attribution → Marketing Analytics. Super Admin edits everything; a Hospital Admin only
`WHATSAPP_NOTIFICATIONS` / `SMS_NOTIFICATIONS`. Changes are serialized per hospital and recorded in the Activity log.

**Enabled ≠ configured ≠ healthy.** The Integration Hub reports them separately for every provider, plus the honest
*mode* (Fixture / Sandbox / Live-capable / Live · configured / Not configured / Disabled / Blocked). Health is only what a
real event or sync last confirmed; changing the mode or a credential resets it.

## Provider boundaries

Provider names appear only in `domain/integration/hub-catalogue.ts` and the adapter registries
(`connector/registry.ts`, `ads/registry.ts`). Adapters: `MessagingProviderAdapter` (WhatsApp send/template/webhook),
`TelephonyProviderAdapter` (Runo), `AdsReportingProvider` (Google Ads, Meta Ads — **read-only**, no mutate call exists).
CCS IVR is **BLOCKED — provider API/webhook documentation required**; nothing about its payload/auth is invented.
SMS has no provider selected and is likewise blocked.

## Notifications

Domain events (appointment/surgery) → rules → durable `notifications` rows (DB-unique idempotency key) → worker re-checks
the visit → approved-template send → provider delivery webhooks move the status forward. Pure suppression logic
(`notification-plan.ts`): trigger already passed, too close to the previous message, cancelled, rule disabled. A staff
"Send WhatsApp" from a follow-up is previewed, never auto-completes the task, and is never auto-retried.

## Ads

Provider → sync run → normalized `ads_daily_facts` (unique provider/account/campaign/day, a re-sync replaces its window) →
Marketing Analytics → *Ad accounts* tab. Provider conversions are never PulseOS outcomes; costs/ROAS exist only for
campaigns PulseOS can tie to its own journeys, with valid denominators. A failed sync keeps the previous snapshot.

## Activity log

`activity_log` (Settings → Activity, Admin/Super Admin). Who, what, entity, safe metadata; secret-named keys are never
stored and text is redacted. Recorded: capability changes, integration settings/credential *names*, webhooks, ads sync
triggers, reminder rules/templates, CRM fields, workflow outcomes, follow-up types, lead sources, report exports.

## Deliberately deferred (documented, not faked)

- **TEAM_LIVE_STATUS** (Available / On call / Wrap-up): the telephony data PulseOS receives (Runo webhooks) arrives per
  *completed* call; there is no presence signal, so "on call" or "idle" would be a guess. Revisit when a provider supplies
  real presence.
- **Custom date-time (sub-day) range**: every report is day-level in the hospital timezone; a time-of-day picker has no
  report that needs it yet.
- **Appointment / Surgery placements for CRM fields** are stored but no screen captures them yet (the editor says so).
- **SMS / CCS IVR** capabilities exist as switches but have no provider adapter until provider documentation exists.
- **Leads column choice** is a per-person, per-browser view preference (no server table).
