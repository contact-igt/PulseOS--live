# Website Leads integration — implementation audit

Date: 19 October 2026 · Branch: `development` (changes uncommitted) · Scope: Integration Hub "Website Leads" (inbound website → PulseOS)

## 1. Verdict

| Area | Status |
| --- | --- |
| Feature built (API, Hub card, settings, token, API-details modal) | Done |
| Pure logic, typecheck, lint, web unit tests | Pass |
| UI behaviour in a real browser (API mocked) | Pass |
| Database-backed integration tests (new and existing intake suites) | **Written, not run** |
| End-to-end submission against a real API and database | **Not verified** |
| Production readiness | **Blocked** (see section 8) |

The feature reuses the existing website-intake route, `website_form` connector, ingestion pipeline and encrypted connector secrets. No lead pipeline was added or replaced. No database migration was needed.

## 2. What already existed (verified in code)

- `POST /forms/website/:connectorId` (`apps/api/src/domain/acquisition/website-form.routes.ts`): tenant from the connector in the URL, optional encrypted `intakeToken` compared in constant time, optional `allowedOrigins`, per-address sliding-window rate limit, Zod validation with field caps, phone normalisation, `submissionId` idempotency through `connector_events`, disabled-connector refusal.
- `processWebsiteFormSubmission` → `ingestNormalizedLead`: patient by phone, journey create/reuse, attribution touchpoint, timeline entry, `new_lead` task.
- Connector `type: ACQUISITION`, `provider: website_form`, capability `RECEIVE_FORM`; one per tenant (unique index on tenant + provider).
- Hub: catalogue, per-card state derivation, `connector_events` Activity log, role split (`MANAGE_INTEGRATION_CONFIG` for Admin, `MANAGE_INTEGRATION_SECRETS` for Super Admin).
- Tests: `website-form.integration.test.ts`, `website-intake-hardening.integration.test.ts`.

## 3. Gaps found before the change

| # | Gap | Effect |
| --- | --- | --- |
| G1 | `website_form` was not in `INTEGRATION_CATALOGUE` (seed-only) | No card in the Hub; only the technical connector workbench |
| G2 | Hub configuration is string-only | `requireService` (boolean) and `allowedOrigins` (array) could not be saved correctly; strings would silently disable `requireService === true` |
| G3 | No token generate/rotate; doc said "use the API" | Setup needed raw API calls |
| G4 | No intake address or sample payload shown | Developers had nothing to copy |
| G5 | Intake with no token is an open door | A connector without a token accepts anyone holding the address |
| G6 | Failed submissions stored `err.message` and the Hub showed it | Database errors can quote request parameters (name, phone): personal data in the Hub and Activity log |
| G7 | `formId` is not enforced by the route | It is a label, not an access boundary (left as is, now documented) |
| G8 | Only processing failures create events | 401, 403, 422 attempts are invisible in Activity (not changed) |

## 4. Changes made

| Path | Purpose |
| --- | --- |
| `apps/api/src/domain/integration/website-leads-rules.ts` (new) | Origin normalisation (https only; http only for localhost; no path, query, credentials or `*`), strict typed form schema, typed read/apply of connector configuration, token generator (`wlk_` + 256 random bits) |
| `apps/api/src/domain/integration/website-leads.service.ts` (new) | Save form settings; create or replace the intake token; safe view (never the token) |
| `apps/api/src/domain/integration/hub-catalogue.ts`, `hub-state.ts` | Website Leads entry (Ads & Attribution, no generic fields) and its enabled/configuration derivation |
| `apps/api/src/domain/integration/hub.service.ts` | Card state, detail (`websiteForm`, intake URL), generic configure refused for this key, read-only status check, error text reduced to a category |
| `apps/api/src/domain/integration/hub.routes.ts` | Two new routes (section 5) |
| `apps/api/src/domain/acquisition/website-form.routes.ts` | `requireToken`: closed until a token exists; failures stored as `processing_failed` only |
| `packages/types`, `packages/api-client` | `website_leads` key, `WebsiteFormView`, `WebsiteFormInputVm`, `saveWebsiteForm`, `rotateWebsiteToken` |
| `apps/web/components/integrations/WebsiteLeadsPanel.tsx` (new), `websiteLeadsDocs.ts` (new) | Form table, editor, token panel, API Details modal, supported-only sample payload and examples |
| `IntegrationDetailSheet.tsx`, `IntegrationCardView.tsx` | Tab wiring, icon, "Last submission", On/Off badge |
| Tests (new/edited) | `website-leads-rules.test.ts`, `website-leads-hub.integration.test.ts`, `websiteLeadsDocs.test.ts`, `integration-hub-state.test.ts`, `integration-hub.integration.test.ts` (new card order) |
| `docs/namokar/NAMOKAR_WEBSITE_INTAKE.md` | Describes the Hub screen and `requireToken` |

Database: none. Unrelated pre-existing changes in the working tree (`apps/web/.env.example` deleted, `globals.css`, `layout.tsx` modified) are not part of this work.

## 5. API contract

| Method and path | Who | Behaviour |
| --- | --- | --- |
| `PUT /integrations/hub/website_leads/form` | Admin, Super Admin | Strict body: `displayName`, `formId` (3–60 chars, `[a-z0-9_-]`), `description?`, `enabled` (bool), `requireService` (bool), `fixedSource` (bool), `allowedOrigins` (array ≤ 20, normalised and de-duplicated). Invalid → `400 invalid_request` with field names. Unknown fields (including a tenant id) rejected. Returns hub detail. Switching off sets status `DISABLED` (intake answers 403) and deletes nothing |
| `POST /integrations/hub/website_leads/token` | Super Admin | Creates or replaces `intakeToken`. Returns `{token, detail}` once, with `Cache-Control: no-store`. The previous token stops working immediately; verification restarts (`CONNECTING`) |
| `PUT /integrations/hub/website_leads/configuration` | existing | Now `409 use_website_form_endpoint` |
| `POST /integrations/hub/website_leads/status` | existing route | Read-only; reports what real submissions proved; never promotes status |
| `GET /integrations/hub`, `/integrations/hub/website_leads` | existing | Card plus `websiteForm`; `hasToken` only |

Intake response contract documented in the modal matches the route: 200 `{ok, duplicate, deduped}` (or with ids when no token), 401, 403 (`connector_disabled` / `origin_not_allowed`), 404, 422, 429 with `Retry-After`, 500 `processing_failed`.

## 6. Status model (honest, never inferred from "saved")

| Situation | Enabled | Configuration | Health | Mode |
| --- | --- | --- | --- | --- |
| No connector | On | Not configured | Not verified | Not configured |
| Saved, no token | On | Partly configured | Not verified | Not configured |
| Token created, no submission yet | On | Configured | Not verified | Live-capable |
| Real authenticated submission received | On | Configured | Healthy | Live · configured |
| Processing error | On | Configured | Unhealthy | Live-capable |
| Switched off | Off | unchanged | unchanged | Disabled |

Rotating the token or switching back on restarts verification.

## 7. Security review

| Check | Result | Evidence |
| --- | --- | --- |
| Tenant from session, never the request | Pass by design; **test not yet run** | Service takes `tenantId` from the session; body schema is strict; cross-tenant test written |
| Token never stored in plain text | Pass by design; test written | Encrypted via existing `encryptSecret`; test asserts the stored payload does not contain it |
| Token never returned after creation | Pass by design; test written | Views expose `hasToken` only; test scans detail, list, logs and save responses |
| Token not in activity log or errors | Pass by code review | Activity metadata lists the field name only |
| Rotation permission | Pass | `MANAGE_INTEGRATION_SECRETS`; UI disables for Admin (browser-verified); API 403 test written |
| Old token invalid after rotation | Pass by design; test written | Single secret slot, no overlap |
| Constant-time comparison, rate limit, origin check | Unchanged | Route code diff touches only the token-required branch and error text |
| New connectors not an open door | Added | `requireToken: true`; older connectors keep prior behaviour |
| Personal data in Hub/Activity | Fixed | Error text replaced by `processing_failed`; card shows a category only |
| Origin allow-list is not authentication | Documented | Field help and modal text |
| Token in browser JavaScript/URL | Prevented by guidance | Server-side-only examples; token shown once in a box, not persisted client-side |
| Existing integrations untouched | Pass by diff | Runo, CCS, WhatsNexus, Meta, Google and Outbound Webhooks code not modified (Hub state tests for them pass) |

## 8. Test evidence

| Command / run | Result |
| --- | --- |
| `apps/web`: `npx vitest run` (single process) | 53 files, 414 tests passed |
| `apps/web`: `npx eslint app components lib e2e` | Clean |
| `apps/web`: `npx tsc --noEmit` | Clean (one stale generated file in `.next/types` ignored) |
| `apps/api`: `npx tsc --noEmit` | Clean |
| `apps/api`: rules, hub state, web-origins, CCS unit tests | 35 passed |
| Chrome, mocked API (temporary, removed) | Passed: card, bad-origin rejection, typed save (boolean and array), confirm then show-once token, API dialog, Escape closes only the dialog, Admin blocked from the token |
| `website-leads-hub.integration.test.ts`, `integration-hub.integration.test.ts`, both intake suites | **Not run** (no database) |

## 9. Issues found and fixed during the work

1. Generic string configuration would have created a fixture-mode connector and stored `"true"` as text → generic path now refused for this key.
2. Raw error text could expose visitor data → category only.
3. API dialog was clipped inside the sheet and fought its focus trap → rendered through a portal with its own Tab/Escape handling.
4. Escape closed the sheet behind the dialog → handled first, in the capture phase.

## 10. Open items and risks

| Severity | Item |
| --- | --- |
| High (blocker) | Database-backed tests have not run. `apps/api/.env` targets a Railway tunnel (`127.0.0.1:54301`) that is down; a disposable database, or explicit approval for the tunnel, is needed |
| High (deploy) | `PUBLIC_API_BASE_URL` must be the public API address, otherwise the shown intake URL is localhost. The local web app's `.env` currently points at the Railway API |
| Medium | 401, 403 and 422 attempts do not appear in Activity |
| Medium | No test-submission button (no safe isolated test tenant) |
| Low | `ConfirmDialog` inside the sheet still closes the sheet on Escape (existing shared behaviour) |
| Low | One website form per hospital in V1; a `website_forms` child table is the extension path |

## 11. Next steps

1. Provide a disposable `DATABASE_URL` (or approve the tunnel), then run the four integration suites and fix anything they find.
2. Set `PUBLIC_API_BASE_URL`, create a token in a staging tenant, and post the documented request from a real website server.
3. Review the diff, commit, and deploy API then web.
