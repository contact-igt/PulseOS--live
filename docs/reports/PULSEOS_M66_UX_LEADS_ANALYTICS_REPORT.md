# PULSEOS BETA V1 — M6.6 UX + LEADS + ANALYTICS REPORT

## STATUS

**M6.6 complete.** Branch `claude/wonderful-carson-o7jbjk`, pushed. Nothing merged to `main` / `feature/pulseos-foundation-convergence`, nothing deployed, no live provider contacted. M7 was not started.
Gate: lint 0 warnings, typecheck 7/7, API 973/973, web 160, UI 132, build OK, fresh migrate (27) + fresh seed OK, full Playwright 295 passed / 1 skipped / 1 failed (a stale nav assertion, fixed and re-run green — see TEST RESULTS). Six review agents (R1–R6) ran; every Important finding was verified and fixed, none were Critical.
M6.5 was closed first (5 stale E2E booking fixtures fixed, final numbers recorded in its report).

## BASELINE / COMMITS

Baseline `b55fb7f` (M6.5 final). 14 M6.6 commits (`dae0666` … `58f8a9b` + the final gate commit): Settings tabs; shared sortable primitive; Outcomes drag E2E; Leads API; Leads page; transactional Add Lead; Add Lead drawer + E2E; analytics API; Analytics workspace; Settings mobile pass + Lead Sources reorder; lint; review fixes (API, UI). 68+ files, ~5.5k lines added.

## SETTINGS TAB OVERFLOW FIX

- **Cause (confirmed in the browser, red first):** the `underline` Tabs variant set `overflow-x:auto` and its buttons used `-mb-px`. Setting `overflow-x` makes `overflow-y` compute to `auto` (it measured `auto`), and the 1px overhang produced a vertical scrollbar.
- **Fix** (`packages/ui/src/Tabs.tsx`, shared by every tab strip): `overflow-x-auto overflow-y-hidden`, active indicator is an inset shadow instead of a negative margin, left/right edge fade (mask, only when there is more to scroll), roving tabindex + Arrow/Home/End, active tab scrolled into view, focus ring drawn inside the tab (review R4), `scroll-px-8` so the fade never covers the selected tab. No carousel library.
- Verified at 1440/1280/1024/768/390: `overflow-y` hidden, no vertical overflow, last tab reachable, no page overflow, ≥44px tabs on phones.

## SORTABLE CONFIGURATION

One shared primitive (`SortableList.tsx`: `useReorder`, `RowOrderControls`, `SortableGroup`, `useSortableRow`, `ReorderStatus`) now serves **Workflow Outcomes, CRM Fields, Follow-up Types and Lead Sources** (Lead Sources gained a reorder API: `POST /lead-sources/reorder`, Admin only, tenant-scoped, row-locked). No copy-pasted dnd-kit code is left.
- **Workflow Outcomes:** the six-dot handle is the only drag activator and the primary control. Row states: idle, hover, dragging (lifted), drop-target, saving, failed-and-put-back. Row hierarchy: [handle] outcome + sub-rule · Edit · Archive; the stage is the group header (system stage, fixed, not editable).
- **CRM Fields:** refactored onto the primitive; same behaviour.
- **Accessibility:** Move up/down are quiet, secondary (visible on row hover/focus on pointer devices, always on touch, always keyboard-reachable). Live-region announcement "Needs callback moved to position 2 of 8." Focus returns to the control used (falls back to the handle at an edge) and is restored only if the move cost focus. Keyboard drag (Space/arrows). DOM order = visual order. `prefers-reduced-motion` honoured.
- **Persistence:** optimistic order, saved through one path, rolled back with an inline message on failure (verified with a forced 500), order survives refresh. Only active rows are ordered (review R5); a per-group save guard.

## LEADS OPERATIONAL VIEWS

New `GET /leads/workspace` (one request: rows, every tab's count, today strip, owner counts, filter options) over a pure, unit-tested module; views are **filters over real data, never stored statuses**.
- **Views:** All, Today, New Today, Uncontacted, Follow-up Due, Appointments Today, Appointment Booked, No Response, Converted, Lost. Lost leads never appear in attention views. Rows are ordered by urgency (earliest due follow-up / earliest visit today / newest enquiry) with an id tie-break.
- **Today strip:** Appointments today · Follow-ups due · Overdue · New leads today. Each opens the matching filter and equals the count it opens (overdue = `dueAt < now`, same clock as the Command Centre).
- **Date filters:** Today, Yesterday, Last 7 days, Last 30 days, This month, Custom. Default context is the **enquiry (journey created) date**; Follow-up Due uses the follow-up's own due date (custom range may look ahead); Today / New Today / Appointments Today are fixed to today and say so (the control is disabled with a visible reason). The context line always states which date is measured, the span and the hospital zone.
- **Owner filters:** All / Mine (the session user) / Unassigned / a person, with counts that follow the other active filters; plus Source and Service filters, removable chips, Reset.
- **Table:** Patient, Enquiry, Original source, Status + outcome, Owner, Last interaction, Next action (from Tasks), Enquiry date (+ next visit). Whole row opens the Journey; Table/Board kept.

## ADD LEAD FLOW

- **Base fields:** phone, name, optional age/DOB; service; branch; source; channel; outcome; next step. Everything else (email, language, journey type, preferred doctor, owner, priority, campaign, notes, optional CRM fields) is under "Additional details"; **required tenant fields are shown up front** and enforced server-side.
- **Source vs Channel** are separate and explained; source survives later interactions. **Channels offered:** Phone call, WhatsApp, Instagram DM, Facebook DM, Walk-in. *IVR is deliberately not offered*: it can only come from the phone system, so a person typing it in would be dishonest (the server refuses it too).
- **Outcome:** the hospital's configured outcomes with plain labels; the rules shape the next step (needs follow-up → only Callback / General follow-up; lost → no next step; no appointments where the outcome disallows them) — enforced on the client and the server.
- **Callback / Appointment / General follow-up / No follow-up:** progressive disclosure (date, time, owner, note; doctor + branch + note; date + time; nothing). Branch is **not** silently preselected in a multi-branch hospital (review R3).
- **Created records — one transaction:** patient (found or created) → journey → honest first-contact timeline line ("Instagram DM manually captured", "Phone call recorded manually" — no provider message is invented) → optional manual call (M4 call log, phone only) → outcome → Callback task via the **M5 follow-up engine** (labelled "Callback") or Appointment via the **M6 booking rules** (past time, same-minute doctor collision, cross-tenant doctor/branch refused). If any step refuses, **nothing** is saved (verified: no patient/journey/task rows) and a structured `{error, step}` comes back; the appointment "booked" event is published only after commit (M7 can subscribe). The drawer keeps everything typed and shows a plain sentence ("This doctor already has another appointment at this time. Choose a different time or doctor."). No notification is sent from Add Lead.
- A connected phone call now marks the lead contacted even without an outcome (review R1).

## ANALYTICS

- **Route / access:** `/analytics` (nav item after Treatments), **Hospital Admin / Super Admin only** (`VIEW_ADMIN_COMMAND_CENTRE`); Front Desk, Coordinator and Doctor have no entry, are redirected, and the API returns 403. Available in every edition. On the growth edition a **Marketing & revenue** area sits beside Operations (existing analytics, unchanged, edition-gated). **No spend / ROAS / campaign content in V1** (asserted in E2E).
- **Global filters:** Date Range (Today, Yesterday, 7d, 30d, This month, Previous month, Custom), Branch, Department (new), Service, Lead Source, Team member, Doctor. Mobile: a Filters button opens the shared side sheet with an active-filter count; Reset appears only when something is set. Chips remove single filters.
- **KPIs:** Enquiries, Follow-ups, Appointments, Checked In, Consultations Completed, No-shows, Surgeries Scheduled, Procedures Completed (each with its denominator / date basis in visible text).
- **Charts/tables:** Day-by-day (chart ⇄ table), Patient flow (Enquiry → Appointment → Checked in → Consultation completed → Surgery scheduled; cumulative, never widens), Lead sources, Service performance, Team workload. Recharts only, tonal blues, no Sankey (no real transition data exists).
- **Daily view:** Date, New leads, Follow-ups due, Appointments, Checked in, Completed, No-shows; accessible sortable headers (`aria-sort`, real buttons); a day, source, service or team member **drills** into the one filter state.
- **One request** feeds every card (one URL filter state → one `/reports/operations` call).

## DATA / FILTER RECONCILIATION

- API test: every daily column sums to its KPI for three different filter sets; E2E repeats this in the browser, and checks each KPI equals the API for the same filters.
- Leads: every view's count equals its rows (unit + integration + E2E); the today strip equals the lists it opens; owner counts ignore the owner filter itself.
- Procedures completed use `completed_at` (never the payment date); revenue/payment dates stay separate. Department filter applies to enquiries, visits, follow-ups and procedures together. Rates use the right denominators (attendance / no-show exclude cancelled visits; consultations ÷ checked in; null, never 0%, without a denominator).

## URL STATE

Leads: `view` (quick view), `layout` (table/board — moved off `view`, which now means the quick view; old `?view=board` links still open the board), `range`, `from`, `to`, `owner`, `source`, `service`, `status`, `due`. Analytics: `aRange aFrom aTo aBranch aDept aService aSource aOwner aDoctor` (own keys so Marketing's `range/branch/source` never collide) and `section`. Refresh and back/forward restore; junk falls back to defaults (no error screen); a span over a year falls back client-side (server would 400). All writes go through the shared `replaceUrlParams` / `useUrlFilters`.

## TIMEZONE

All new day logic is hospital time (tenant timezone): Leads views and ranges, analytics periods, add-lead wall times (`parseInstant`). Audit across Leads, My Work, Appointments, Front Desk, Treatments, Analytics: all take "today" from the hospital zone and write filters through the shared helpers; no change needed. A **static guard test** now fails if browser-local Date APIs (`getHours`, `toLocaleDateString` without `timeZone`, …) appear in UI code (verified it can fail). E2E with a browser in Los Angeles for Leads and Analytics.

## UX / RESPONSIVE / ACCESSIBILITY

- Matrix 1440/1280/1024/768/390 asserted in E2E for Settings tabs, Outcomes drag, Leads, Add Lead, Analytics overview/filters/daily chart/table: no page overflow.
- 44px touch targets on phones: shared `Button` (sm and md), tab buttons, sort headers, Settings row buttons, Leads selection/assign controls — a permanent test measures every control in every Settings section at 390.
- Add Lead: contrast fixed (section headings), 44px close, dialog focus trap and focus return, errors announced and focused, no business error produced a Next.js overlay (asserted).
- Visual review done with screenshots (blue/white, restrained semantic amber only for operational attention). The `frontend-design` skill is not installed here, so the CLAUDE.md design rules were applied directly.

## TENANT / RBAC

- Review R6 found `POST /leads` accepted another hospital's `ownerId` / `branchId` / `campaignId` (pre-existing, but the new next-step flow would have turned a foreign owner into an assigned task). **Fixed**: all three are tenant-validated before any write; the `users` join is tenant-scoped; regression test added.
- Tenant always from the session (smuggled `tenantId` ignored in tests); Leads workspace needs `MANAGE_LEADS`; analytics data `VIEW_ADMIN_COMMAND_CENTRE`; lead-source reorder `MANAGE_SPECIALTIES` with foreign ids refused. A Doctor-home console 403 introduced by my outcome fetch was caught by E2E and fixed (fetched only for roles that can add leads).

## TEST RESULTS

| Check | Result |
|---|---|
| Lint | 2/2 packages, **0 warnings** |
| Typecheck | 7/7 |
| API (vitest, includes integration) | **973 / 973** (89 files) — new: lead-views, leads-workspace, lead-intake, extended operations-report, lead-sources reorder |
| Web unit | **160** (27 files) incl. useReorder, leadFilters, SortableTable, opsMath, reportFilters, nav, hospital-time guard |
| UI unit | **132** (16 files) incl. Tabs, addLeadModel |
| api-client / design-tokens | 9 / 6 |
| Build | OK |
| Fresh migration | 27 migrations apply on an empty database |
| Fresh seed | OK — 3 demo tenants, 100 journeys (dev database was then reset the same way) |
| Playwright, full (297) on the fresh seed | **295 passed, 1 skipped (pre-existing), 1 failed**: `foundation-m2` still asserted that a V1 tenant hides Analytics; operational Analytics is now core by design. Assertion updated, spec re-run 5/5. The full suite was not re-run end to end after that one-line test change. |
| M6.6 specs re-run WITHOUT reseed | **54 / 54** (Settings UX 15, Leads 12, Add Lead 11, Analytics 14, + screenshots) |

Playwright counts for the M6.6 specs: Settings 15 (tabs ×5 viewports, keyboard, focus ring, targets, outcomes drag ×6, lead sources), Leads 12, Add Lead 11 (A, B, C, outcome rules, past time, branch, keyboard, 4 viewports), Analytics 14.

## FILES CHANGED

- **API:** `domain/lead/{lead-views,lead.service,lead.routes,lead-source.service,lead-source.routes}`, `domain/report/{operations-report.service,report.routes,report-export.service}`, `domain/appointment/appointment.service` (after-commit hook), `domain/crm/crm-outcome.service` (skipFollowUpTask), seeds (stepError handling), `domain/treatment/treatment.routes` (unused import).
- **Types / client:** `packages/types` (LeadView, workspace, CreateLeadNextStep, analytics pipeline, department), `packages/api-client`.
- **UI package:** `Tabs.tsx` (new), `primitives.tsx` (Button 44px), `AddLeadDrawer.tsx` + `addLeadModel.ts`.
- **Web:** `components/settings/{SortableList,CrmFieldsSection,FollowUpTypesSection,LeadSourcesSection}`, `components/outcomes/OutcomesSection`, `components/leads/*`, `components/filters/PeriodControls`, `components/analytics/{OperationsAnalytics,SortableTable,opsMath}`, `components/report/{ReportFilterBar,reportFilters,OperationsReportView}`, `components/shell/{nav,QuickCreateProvider}`, `app/(app)/{leads,analytics,settings}`.
- **Tests:** API 5 files, web/UI unit 8 files, E2E `m66-settings-ux`, `m66-leads`, `m66-add-lead`, `m66-analytics` + updated `crm-*`, `multi-specialty-demo`, `m65`, `views-leads`, `analytics`, `foundation-m2`.

## REMAINING RISKS

1. **Branch / Doctor filter semantics (analytics):** branch = patient's branch for enquiries/follow-ups but the visit's/procedure's branch for visits/surgeries; Doctor narrows visits and surgeries only. Documented in an on-screen note and chip text, but a branch pick can still show visits whose enquiry sits at another branch.
2. **Follow-ups "due"** counts only still-open tasks, so a past day's "due" understates history; labelled "still open and due".
3. **Appointment Booked view vs the status badge:** the view means "visit not yet happened"; the older derived badge also covers checked-in/completed visits. Different on purpose, not unified.
4. **IVR channel** is not manually selectable (design decision above); IVR leads arrive via the telephony webhook only.
5. **Other reorder services** (Outcomes, Follow-up Types, CRM Fields) still read slots outside their transaction (only Lead Sources is row-locked); low risk, unique slots in practice.
6. **Procedures export** still carries payment date and estimated value (kept separate from completion date, pre-existing); not shown on screen in V1.
7. **Leads load the whole tenant** into memory per request (as before); fine for pilot volumes, needs SQL pushdown at scale.
8. **Operations report tab** in the Command Centre still exists alongside Analytics (same data, same API); a later cleanup could remove the duplicate.
9. Dev-mode E2E is slow (~21 min); the one-line `foundation-m2` change was verified alone, not by a second full run.
10. iOS Safari zooms on small inputs app-wide (pre-existing).

## M7 READINESS

**READY.** Recommended next module: **M7 — Notification + Reminder Engine.** Prerequisites are in place: the appointment "booked / rescheduled / cancelled / no-show / completed" domain events (published after commit, including the new Add Lead path), Follow-up Tasks with due times in hospital time, honest manual-capture timeline wording, tenant-validated references, and consent-free staff-only flows (no provider sending exists yet). M7 was not started.
