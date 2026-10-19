# Website Leads Webhook Integration — PulseOS implementation report

Date: 19 October 2026

## Decision

Implement a **Website Leads** inbound integration in the existing Integration Hub. It should expose and configure the already-live PulseOS website intake endpoint; it should **not** be built as an outbound webhook or as a new lead-ingestion pipeline.

This is the closest useful equivalent of Runo's *Integrations → Website → Add Form → View API Details* flow:

1. Admin creates or opens a named website form.
2. PulseOS shows a copyable, tenant-scoped endpoint and a sample JSON request.
3. The website backend posts each enquiry to that endpoint.
4. PulseOS creates/reuses the patient, creates/reuses the website journey, records attribution, timeline activity, and a `new_lead` follow-up task.
5. The integration page shows its status and recent inbound events.

The product boundary matters: Runo's screen is an **inbound lead receiver** (a URL that another website calls). PulseOS's existing Advanced → Outbound Webhooks are the opposite direction (PulseOS sends selected internal events to another system). They must remain separate.

## What Runo appears to do

The supplied Runo screens show a Website integration with a table of forms, **Add Form**, edit/copy/delete controls, and a **View** modal. The modal provides:

- a unique API URL containing opaque identifiers;
- a copy button;
- a sample JSON body using contact and optional lead fields such as name, email, phone, company, message, subject, address, city/state, status, and source.

That is a simple contract: a customer maps their website form/backend fields to Runo's request body and posts it when the form is submitted. It is not a browser widget or a hosted form builder.

Runo’s public material also describes integrations with lead sources and other work apps, but I did not find public API documentation that independently confirms the exact endpoint, authentication, retry, or form-ID rules. The observations above are therefore based primarily on the supplied authenticated UI screenshots, not reverse engineering.

## Current PulseOS flow (already implemented)

### Inbound endpoint and trust boundary

`POST /forms/website/:connectorId` in `apps/api/src/domain/acquisition/website-form.routes.ts` already accepts website submissions.

| Concern | Current behavior |
| --- | --- |
| Tenant selection | The URL connector ID resolves the tenant; a body value cannot choose a tenant. |
| Authentication | Optional encrypted `intakeToken`, sent in `X-PulseOS-Intake-Token`; compared in constant time. When configured, it must be added by the website server, never browser JavaScript. |
| Browser origin | Optional `allowedOrigins` allow-list rejects an unapproved browser `Origin`. Server-to-server requests have no Origin and use the token. |
| Abuse control | Per connector + client address sliding-window rate limit; default 20/minute, configurable by `FORM_INTAKE_MAX_PER_MINUTE`. |
| Input safety | Zod validation, field size caps, valid email and normalized phone validation; unknown body fields are discarded. |
| Idempotency | `submissionId` is recorded through `connector_events`; retries return success with `duplicate: true` and do not create another lead. |
| Failure visibility | Processing failures are recorded as connector events and update connector error health. |

Accepted body today:

```json
{
  "submissionId": "a-unique-id-per-submit-or-retry",
  "formId": "website-contact-v1",
  "name": "Asha Sharma",
  "phone": "+919876543210",
  "email": "asha@example.com",
  "service": "Cataract consultation",
  "message": "Please call after 5 pm",
  "language": "English",
  "branchId": "optional UUID",
  "pageUrl": "https://clinic.example/contact",
  "utm": { "source": "google", "medium": "cpc", "campaign": "cataract-search", "content": "ad-a", "term": "cataract surgery" },
  "clickIds": { "gclid": "optional", "gbraid": null, "wbraid": null, "fbclid": null }
}
```

Required fields are `submissionId`, `formId`, `name`, and `phone`; a tenant may additionally require `service`.

### Lead processing

`processWebsiteFormSubmission` in `website-form.service.ts` converts the submission to the shared `NormalizedLead` model and calls `ingestNormalizedLead`. This means website leads already receive the standard acquisition behavior:

- phone-based patient identity resolution;
- creation or reuse of an open journey;
- first/last-touch campaign attribution, UTM values and Google/Meta click IDs;
- source `website` by default, or a tenant’s configured fixed `website` source;
- website-form timeline event and enquiry/page URL description;
- two-hour `new_lead` follow-up task;
- connector event/audit health data.

Existing integration tests cover accepted submissions, missing fields, same-event idempotency, same-patient journey reuse, disabled connectors, token/origin protections, field bounds and rate limiting in:

- `apps/api/src/__tests__/website-form.integration.test.ts`
- `apps/api/src/__tests__/website-intake-hardening.integration.test.ts`

### Existing UI/configuration gap

The seeded connector exists as `type: ACQUISITION`, `provider: website_form`, with capability `RECEIVE_FORM`. However it is not in `INTEGRATION_CATALOGUE`, so it is not shown in the Integration Hub shown in the supplied PulseOS screen. It can be discovered through the technical **Connectors & Phone Lines** workbench, but the main Hub provides no website-lead card, form list, copyable intake URL, sample request, nor test submission control.

The Hub’s generic configuration input is currently string-only. Website intake configuration needs a boolean (`requireService`) and a string array (`allowedOrigins`), so forcing it through the generic form would be error-prone.

## Recommended smallest complete implementation

### V1: one secure Website Leads integration per tenant

Expose the existing connector as a first-class **Website Leads** Integration Hub card (new `ACQUISITION` category, or a clearly labelled card in the current Growth/Ads area). Do not add a general payload-mapping engine in V1.

Card/sheet behavior:

1. **Overview** — purpose, configured/healthy state, last submission, and recent inbound activity.
2. **Website form setup** — display name, `formId`, enabled state, whether service is required, fixed source, and allowed origins.
3. **API details** — copyable URL (`${PUBLIC_API_BASE_URL}/forms/website/${connectorId}`), required header name, exact sample JSON, expected 200/401/422/429 responses, and backend-only token warning.
4. **Credentials** — generate/rotate `intakeToken`; show it exactly once after generation, then show only “secret saved.”
5. **Test submission** — an authenticated fixture request that proves Patient → Journey → Task → Timeline processing. It must be clearly marked test and avoid silently creating production patient data; preferably only enabled for a sandbox/fixture connector.
6. **Activity** — reuse `connector_events`/Integration Activity Logs rather than creating another delivery log.

Use one `formId` such as `website-contact-v1` initially. It permits any website backend to identify the form without duplicating credential, ingestion, attribution, and monitoring code.

### Why not copy every Runo feature now

Multiple independent forms with their own URL/token, arbitrary field mapping, custom lead stages, arbitrary custom fields, and browser SDK snippets add configuration and security surface without being needed to ingest the first website form. The current typed schema is a better healthcare-data boundary.

If several forms become a real requirement, extend V1 with a `website_forms` child table (name, form ID, enabled, optional branch/service defaults, a per-form token) and retain the shared endpoint. Do not create a connector per form: it fragments health, rate limits, and activity logs.

## Implementation map

| Area | Change needed | Existing reusable piece |
| --- | --- | --- |
| Shared types | Add `website_leads` integration key/category/card view model only if the Hub must render it. | `IntegrationKey`, catalogue types. |
| Hub catalogue | Add Website Leads backed by `website_form` / `ACQUISITION`, with its purpose and mapping note. | `apps/api/src/domain/integration/hub-catalogue.ts` |
| Hub service/routes | Return endpoint/configuration safely; add a dedicated structured config/update operation instead of coercing array/bool fields to generic strings. | `hub.service.ts`, `hub.routes.ts`, connector secret storage. |
| UI | Add a compact Website Leads detail panel, API-details copy block and backend integration instructions. | `IntegrationHub`, `IntegrationDetailSheet`, `LogsPanel`, existing copy controls. |
| Endpoint | No new lead pipeline. At most add a safe test endpoint and rotate-token action. | `website-form.routes.ts`, `website-form.service.ts` |
| Tests | Add Hub visibility/permissions and UI/API-details tests; retain existing route hardening suite. | Existing website form and Integration Hub tests. |
| Docs | Publish the sample server-side request and privacy note for clinic web teams. | This report can become the base. |

## Proposed admin and website workflow

```text
Super Admin: Integrations → Website Leads → Configure
  → set allowed clinic website origins + form ID
  → generate intake token once
  → copy URL + sample request

Clinic website backend
  → validates its own public form / bot protection
  → generates submissionId once and preserves it on retry
  → POSTs JSON + X-PulseOS-Intake-Token to PulseOS

PulseOS
  → validates/authenticates/rate-limits
  → idempotency guard
  → Patient + Journey + attribution + timeline + new_lead task
  → connector event/activity visible in Integration Hub
```

## Acceptance criteria

1. A Super Admin can find **Website Leads** from Integrations without using the raw connector workbench.
2. The page exposes the correct tenant connector URL and never exposes a saved token after the initial generate/rotate response.
3. A developer can submit the documented JSON from a server and receive a predictable response.
4. A valid unique submission creates/reuses the exact existing PulseOS lead flow; a repeated `submissionId` remains idempotent.
5. A wrong token, disallowed Origin, invalid data, disabled integration, and rate-limit breach retain their current safe behavior.
6. Admins can see recent successful/failed submissions but cannot view raw secrets or unnecessary patient payload in integration logs.
7. Hospital Admin versus Super Admin permissions remain aligned with current Integration Hub rules: operational configuration versus secrets/token rotation.

## Open product decisions before build

- Is V1 intended for one general clinic contact form, or do you already have multiple forms needing separate routing/default branch/service?
- Must the hospital website call PulseOS directly from the browser? Recommended answer: no; use the website backend so the shared token is never public.
- Should a successful integration test create test records in a production tenant? Recommended answer: no—use sandbox/fixture only, or a clearly flagged, cleanable test mode.
- Which staff role should own website form configuration? The present credential model makes token generation/rotation Super Admin only.

## Sources and evidence

- Supplied Runo authenticated UI screenshots (Website form table and API Details modal), reviewed 19 October 2026.
- [Runo call-management product page](https://runo.in/call-management-crm/) states that Runo supports API integration with lead sources and other work apps; it does not document the screenshot-specific Website Form API contract publicly.
- PulseOS implementation and tests cited throughout this report, inspected in this repository on 19 October 2026.
