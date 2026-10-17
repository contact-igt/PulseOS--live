# Leads Edit — implementation plan (2026-10-17)

Goal: staff can edit an existing lead (a Journey plus its Patient) from the Leads workspace and see an analysis of it, without leaving the list.

## Findings (before this work)
- A "lead" is a `journeys` row joined to its `patients` row; lead status is derived, never stored.
- Create is `POST /leads` (one transaction, `lead.service.ts`) with `AddLeadDrawer` in `packages/ui`.
- There was no patient/journey edit endpoint (only `PATCH /journeys/:id/owner`), and custom field values were written only on create and by outcome logging.
- `patients` / `journeys` had no `updated_at`; there is no general audit table, only `timeline_events.metadata`.

## Decisions
- UI: right-side **Edit Lead drawer** (Details tab editable, Insights tab read-only). Entry: row `…` menu, journey detail page, `?edit=<journeyId>`.
- Editable: patient (name, DOB/age, email, language, branch, marketing consent, phone) and journey (enquiry type, service, source, priority, notes, owner, custom fields).
- Not editable here: stage / lead status (derived); outcome, follow-up and appointment (existing flows).
- Permissions are enforced server-side per field group: patient fields `EDIT_PATIENTS`; journey fields `MANAGE_LEADS`; owner `MANAGE_JOURNEYS`; custom fields by `visibleTo` / `readOnly`.
- **Phone** is the identity key: editable for `EDIT_PATIENTS`; a number that belongs to another patient is refused with 409 naming that patient; never auto-merged.
- **Source** is attribution: correction is admin-only (`MANAGE_JOURNEYS`... see service), needs a reason, and writes a "Source corrected X → Y" timeline line. Campaign stays read-only.
- Concurrency: `updated_at` on `patients` and `journeys`; a stale save returns 409.
- History: a `lead_updated` timeline event with `metadata.changes = [{field,label,from,to}]`, plus a `lead.updated` integration event. A general AuditEvent table is out of scope.

## Build order
1. Migration (`updated_at`), shared types.
2. API: failing integration tests → `GET /leads/:id/edit`, `PATCH /leads/:id`.
3. api-client + pure `editLeadModel`.
4. Extract shared Add Lead fields; `EditLeadDrawer`; wiring (row menu, journey page, deep link).
5. Insights tab (from `getJourneyDetail`).
6. Tests, typecheck, lint, build, browser check, Playwright spec.
