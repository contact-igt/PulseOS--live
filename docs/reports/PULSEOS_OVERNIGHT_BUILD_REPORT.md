# PULSEOS OVERNIGHT BUILD REPORT

Session: cloud, 2026-10-01 → 02 (UTC 18:20 → ~20:30; IST 23:50 → ~02:00). Branch `claude/wonderful-carson-o7jbjk`,
from `9bdaa4d`. Nothing was merged, force-pushed, deployed, or sent to an external provider. The full audit is in
[docs/audits/PULSEOS_CLOUD_FULL_AUDIT.md](../audits/PULSEOS_CLOUD_FULL_AUDIT.md).

## 1. Executive Summary

**Before tonight.** M5 and M6 at `9bdaa4d` were real and well tested at the API level: 843 API tests, 233 Playwright
specs. The product had three gaps:
- **Wrong time display.** It showed dates and times in the browser's timezone, and the seed placed "today" by the
  server clock. Five M5/M6 E2E flows failed in a UTC browser, and API tests failed between 18:30 and 24:00 UTC.
- **No management reporting.** The Command Centre had no date-ranged report and no export.
- **CRM field ordering was arrows only.**

**Completed tonight (4 commits, pushed):**
1. **Hospital-timezone correctness** in display and input across the UI, plus a hospital-clock seed. Regression tests
   cover the UTC≠IST window.
2. **Command Centre → Operations report:**
   - 7 period presets including custom, in hospital days.
   - 5 server-side filters.
   - KPI groups, a day-by-day chart with a table view, the enquiry funnel, and source / service / team breakdowns.
3. **Real Excel (.xlsx) export:** 4 workbook kinds, RBAC-gated, tenant-scoped, inheriting the screen's filters.
4. **CRM field drag-and-drop ordering** with keyboard and arrow alternatives, optimistic save and rollback. The field
   editor no longer offers placements that no screen renders.
5. **Developer setup:** README, `apps/web/.env.example`, and the correct default API port.

**What remains (details in §14):**
- Booking past-time and overlap guard.
- Login throttling.
- An AuditEvent store.
- Seed surgery doctor/branch data.
- Workflow-settings polish (system vs configurable labelling).
- Live integrations (blocked by credentials).

## 2. Audit Result

M5 has 12 PASS and 1 PARTIAL; M6 has 13 PASS and 2 PARTIAL. All partials are either fixed or seed-only.

RBAC, tenant isolation and the edition gate were verified live, role by role. The baseline E2E run was 225 passed,
7 failed, 1 skipped:
- 5 failures were the timezone display bug (fixed).
- 1 was ICU punctuation (test made tolerant).
- 1 was container font metrics (open, P3).

Integrations are all FIXTURE or NOT CONFIGURED and honestly labelled. See the audit for the full tables and the bug list
B-01…B-13.

## 3. Bugs Fixed

| ID | Severity | Root cause | Fix | Tests |
|---|---|---|---|---|
| B-01 | High | `@pulseos/ui` formatters (`fmtDate/Time/DateTime/SmartDateTime`, Timeline day groups, Doctor "today") had no `timeZone`, so the browser's zone was used | One hospital display zone in `format.ts` (`setDisplayTimeZone` / `getDisplayTimeZone` / `hospitalDayKey` / `hospitalDaysAgo` / `isSameHospitalDay`), set from the session by the (app) layout before any page renders | `format-timezone.test.ts` (4 cases incl. 00:30 IST "Today" while UTC is on the previous day); M5/M6 E2E specs 30/30 green in a UTC browser |
| B-02 | High | Log Outcome follow-up time and Inbox AI schedule parsed `datetime-local` in the browser zone | Read and write hospital wall time via `lib/hospitalTime`; default "tomorrow 10:00" is the hospital's tomorrow | `outcomeForm.test.ts` (IST, Dubai, after-midnight cases) |
| B-03 | Medium | Seed demo clock and relative days used `getHours`/`setDate` on the server clock | `zonedWallTime` / `minutesOfDayIn` in `lib/hospital-time.ts`; demo clock, `daysFromNow` and appointment demo now reason in Asia/Kolkata | `hospital-wall-clock.test.ts` (5) + rewritten `demo-clock.test.ts` (33) |
| B-04 | Low | Integration test compared the hospital "today" with the test process's UTC day | Uses `hospitalTodayBounds` | API suite green at 01:16 IST |
| B-05 | Medium | Web → API default port 4000 (API runs on 4310), undocumented | Default 4310, `apps/web/.env.example`, root README | Live login |
| B-06 | Medium | CRM placements Appointment/Treatment offered, rendered nowhere | `FIELD_PLACEMENTS[].shown`; editor offers only rendered placements (and lets an old field switch one off) | `crm-field-ordering.spec` |
| B-13 | Low | Export filename not readable cross-origin | `Access-Control-Expose-Headers: Content-Disposition` | integration + E2E download |
| test | Low | Week-view E2E matcher depended on ICU punctuation | Matches the words | spec green |

## 4. Command Centre / Analytics

**Where:** Command Centre → **Operations report** tab (`/command-centre?cc=report`). The Overview tab is unchanged.

**Access:** Super Admin and Hospital Admin (`VIEW_ADMIN_COMMAND_CENTRE`). It works in both editions because it shows no
spend or ROAS.

**KPIs.** Every figure comes from real rows, and each KPI's tooltip states its definition.

| Group | KPIs |
|---|---|
| Enquiries | New; Not contacted; No response (latest outcome "No answer" and the enquiry went no further) |
| Follow-ups | Due in period; Overdue now; Completed in period |
| Appointments | Booked (created in period); Attended / scheduled in period; No-show; Cancelled |
| Conversion | Procedures planned (planned date in period); Procedures completed (dated by first revenue event, else planned date — there is no completion column); Enquiries converted + rate |

**Charts and tables:**
- **Day by day:** grouped bars for enquiries, appointments and attended, with a table view (7 columns per day, sticky
  header).
- **Enquiry funnel:** Enquiries → Contacted → Booked → Attended → Procedure scheduled → Converted. It is cumulative, so it
  never widens, and it is tested.
- **By service:** ranked bars.
- **Sources:** a table with contacted / booked / attended / converted / conversion %.
- **Team workload:** a table with owned enquiries, not contacted, follow-ups due / overdue / done.

No pie charts. Every chart has a text summary for screen readers and an empty state.

**Filters:**
- **Period:** Today, Yesterday, Last 7 days, Last 30 days, This month, Previous month, Custom (max 366 days, never after
  the hospital's today).
- **Other filters:** branch, service, source (the hospital's `lead_sources`, i.e. where the patient came from), team
  member, and doctor.
- **Channel** (how a single interaction happened) is a per-interaction attribute, so it is deliberately not offered as a
  journey filter.
- Filters live in the URL (`rRange`, `rFrom`, `rTo`, `rBranch`, …), so they survive refresh, back and shared links. They
  show as removable chips, with Reset. On phones they move into a bottom sheet with focus trapping.

**Date semantics:**
- Every day is a hospital calendar day (`tenants.timezone`), resolved server-side by `resolveReportPeriod`.
- Enquiry figures follow journeys created in the period; appointments follow the visit date. The page states this under
  the filter bar.
- Branch means the patient's branch for enquiries and follow-ups, the visit's branch for appointments, and the
  procedure's branch for procedures.

**Backend:**
- `GET /reports/operations` and `GET /reports/filter-options`.
- One period-bounded fact query per entity, aggregated once, so the screen and the workbook can never disagree.

## 5. Excel / Data Export

**Endpoint:** `GET /reports/export?kind=summary|enquiries|appointments|follow-ups&<same filters as the report>`.

| Workbook | Contents |
|---|---|
| `summary` | Summary (each measure with its definition), Day by day, Funnel, By source, By service, By team member |
| `enquiries` | One row per enquiry created in the period |
| `appointments` | One row per visit scheduled in the period |
| `follow-ups` | Follow-ups due or completed in the period |

Every workbook also has an **About** sheet (hospital, period, timezone, filters in words, generated at / by).

- **Format:** genuine OOXML built by `exceljs`; the test round-trips the file. Bold, tinted, frozen header row with
  autofilter. Dates are written as hospital-time text ("02 Oct 2026, 11:00"), so no spreadsheet can shift them.
  Filename: `pulseos-<kind>-<hospital>-<from>_to_<to>.xlsx`.
- **Permissions:** the new `EXPORT_REPORTS` permission (Super Admin, Hospital Admin) on top of
  `VIEW_ADMIN_COMMAND_CENTRE`. Staff and doctors get 403 (tested).
- **Tenant scope:** taken from the session. Another hospital passing this hospital's ids, or a `tenantId`, gets empty
  sheets (tested). Responses are `no-store` and `nosniff`.
- **Logging:** each export is logged with kind, row count, user and tenant, but never patient data. There is no
  AuditEvent table yet (see §14).
- **Limits:**
  - 50,000 rows per sheet (413 with a clear message above that); periods are capped at 366 days.
  - Patient name and phone are included because the exporting roles already see them.
  - Exports are built in memory, which is fine at hospital scale. Stream them if volumes grow.

## 6. Settings / Customization

- **CRM Fields:**
  - Drag the grip handle. The grip is the only drag activator, so clicking a row still edits it. A lifted row is
    outlined and raised and its neighbours shift to show where it will land (150 ms; no motion under
    `prefers-reduced-motion`).
  - Keyboard: Space to pick up, arrows to move, Space to drop, with screen-reader announcements.
  - The up/down arrows stay and are the phone path; the grip is hidden below `sm`.
  - Each row shows its position number.
  - Drag and arrows share one optimistic save path through `POST /crm/fields/reorder`. Rows are locked while saving and
    roll back with an inline message on failure. Order is unique per group and persisted server-side.
  - The field editor already had progressive disclosure (options only for choice types), required, group, visibility,
    default and scope. It now explains where each placement appears and no longer offers unrendered placements.
- **Services, Departments, Lead Sources, Workflow Outcomes, Follow-up Types, Doctors, Allocation Rules:** audited
  (all load, all role-gated); no changes tonight.
- **Workflow customization:** **not changed tonight.** Canonical stages and the appointment / treatment state machines
  are already code-owned and not tenant-editable. Hospital-configurable items (outcomes, follow-up types, sources,
  allocation rules) are already admin-managed with archive-not-delete. The recommended next step is labelling in
  Settings that distinguishes system-required states from hospital-configurable ones (§19).

## 7. Backend Changes

- **New module `domain/report/`:**
  - `report-period.ts`: pure preset resolution in hospital days.
  - `operations-report.service.ts`: facts and aggregation.
  - `report-export.service.ts`: workbooks.
  - `report.routes.ts`.
- **Validation:** zod with unknown keys stripped; UUID ids; strict date format and semantics; 400s never become 500s.
- **RBAC:** route-level `requirePermission`. New permission `EXPORT_REPORTS`.
- **Tenant isolation:** every join is tenant-scoped (including lookups for filter labels).
- **Queries:** bounded by the period. Booked / attended / procedure / converted are EXISTS subqueries per journey.
- **`lib/hospital-time.ts`:** `zonedWallTime`, `minutesOfDayIn`.

## 8. Database Changes

- **Migrations:** none (no 0026).
- **Schema:** unchanged.
- **Indexes:** unchanged. Recommendation: `appointments(journey_id)` when volumes grow.
- **Seed:** behaviour is unchanged except that "today" is now the hospital's today whatever the server zone.
- **Verified:** migrate from an empty database plus seed.

## 9. UI/UX Work

- **Desktop:** Operations report with one-line glass filter bar, grouped KPI cards (no giant tiles), chart/table toggle,
  2-column breakdowns at ≥1280.
- **Tablet:** filters collapse to a sheet below `lg`; KPI groups 2-up.
- **Mobile 390:** period select and Filters/Export stay visible, KPI groups stack, tables scroll inside their own
  container, no page overflow (tested).
- **Accessibility:**
  - Labelled selects and date inputs.
  - KPI hints in `title`, plus "needs attention" text, not colour alone.
  - Chart `role="img"` summaries.
  - Table captions and `th scope`.
  - Export menu `role="menu"`, closes on Escape.
  - Drag-and-drop keyboard path with live announcements.
- **States:** skeletons on first load, dimmed previous data on refetch (no flash), error state, per-panel empty states.
  Permission: the tab is only reachable by admin roles, and the API refuses others.

## 10. Integrations

| State | Integrations |
|---|---|
| LIVE | none |
| FIXTURE | WhatsApp Meta Cloud, Runo, Meta Lead Ads, Google Ads lead forms, GBP (performance), Website form (own endpoint, working) |
| PARTIAL | GBP (performance sync only) |
| NOT CONFIGURED | Exotel, Superfone (no adapters) |
| BLOCKED | All live provider traffic — external credentials required |

No integration work was done tonight. Nothing was sent to any provider.

## 11. Test Results

| Gate | Baseline (`9bdaa4d`) | Final (after tonight) |
|---|---|---|
| typecheck | 7/7 | 7/7 |
| lint | 2/2 | 2/2 |
| build | pass | pass |
| migrate (empty DB) + seed | pass | pass (26 migrations) |
| API (vitest) | 843 — 1 to 4 failing depending on the time of day | **862/862** (81 files) at 01:16 IST, inside the UTC≠IST window |
| web unit | 106 | **113/113** |
| ui | 98 | **102/102** |
| api-client | 9 | 9/9 |
| design-tokens | 6 | 6/6 |
| Playwright | 225 passed / 7 failed / 1 skipped (233) | **237 passed / 1 failed / 1 skipped (239, 17.6 min)** — the one failure is the pre-existing B-10 dev-login 46px font-metrics check (also failed at baseline); all 7 M5/M6/timezone-related baseline failures now pass |

New tests:
- **API:** `operations-report.integration.test.ts` (14), `hospital-wall-clock.test.ts` (5).
- **UI:** `format-timezone.test.ts` (4).
- **Web:** `reportFilters.test.ts` (5) plus outcome-form timezone cases.
- **E2E:** `operations-report.spec.ts` (3), `crm-field-ordering.spec.ts` (3).

## 12. Responsive QA

| Width | Result |
|---|---|
| 1440 | Operations report, CRM Fields, all 23 routes × 7 accounts: no overflow, no console errors |
| 1280 / 1024 | Existing `responsive-matrix` / `no-overflow` suites pass |
| 768 (820 sweep) | Admin and Front Desk, every route: no overflow |
| 390 | Operations report (E2E asserts no overflow + filter sheet), CRM Fields arrow path, Admin and Front Desk sweep: no overflow |

## 13. Screens / Routes Manually Verified

Screenshots reviewed:
- `/command-centre?cc=report` at 1440 / 768 / 390 (chart and table views).
- `/settings?section=fields&service=CATARACT` at 1440.

Scripted sweep (253 loads): every sidebar route and all 8 Settings sections, plus a Journey Detail and a Patient 360,
for Ophthalmology V1 Admin / Super Admin / Front Desk / Coordinator / Doctor, Ophthalmology V2 Admin, and Gynecology
Admin.

## 14. Known Issues Remaining

- **P0:** none.
- **P1:** none known.
- **P2:**
  - B-07 booking accepts a past time and has no doctor overlap check.
  - B-08 no login throttling.
  - No AuditEvent store (exports, role and archive actions).
  - Treatment completion has no timestamp column (reports infer it).
- **P3:**
  - B-09 seeded surgeries without doctor/branch.
  - B-10 dev-login 46px (container fonts).
  - B-11 unused `SESSION_SECRET`.
  - B-12 `appointments.journey_id` index.
  - Node 22 in cloud vs 24 locked.
  - Playwright browser pin vs cloud image.

## 15. Architecture / Technical Debt

- **Time handling.** The hospital-time rule is now centralized (`@pulseos/ui` formatters + `lib/hospitalTime` +
  `lib/hospital-time`). A lint rule against raw `toLocale*` / `getHours` outside those modules would keep it that way.
- **Reporting.** The report service and the analytics workspace both build period-bounded fact sets. If a third report
  appears, extract the shared scope/period helpers.
- **Naming.** The `doctorId` request field carries a schedule-resource id, and the DB value `scheduled` is displayed as
  "Booked".

## 16. Commits Created

| Commit | Purpose |
|---|---|
| `3c1957f` | fix: show and enter times in the hospital's timezone, not the browser's or server's (+ seed clock, dev setup, README) |
| `739e330` | test: express demo-clock expectations in hospital wall time (follow-up to `3c1957f`; the existing seed test still read the process clock) |
| `fe3baa5` | feat: Command Centre operations report with hospital-day filters and Excel export |
| `e20fccb` | feat: drag-and-drop CRM field ordering with keyboard and arrow alternatives |
| (this report) | docs: cloud full audit + overnight build report |

## 17. Branch State

- **Cloud branch:** `claude/wonderful-carson-o7jbjk`, pushed to origin.
- **Not touched:** `main` and `feature/pulseos-foundation-convergence` (not merged into either).
- **HEAD:** see `git log -1` (the docs commit on top of `e20fccb`).
- **Working tree:** clean apart from gitignored local files (`apps/api/.env`, `apps/web/.env.local`, `review-artifacts/`).
- **Local servers:** left running — web `http://localhost:3310`, API `http://localhost:4310`.

## 18. What I Should Review Tomorrow Morning

1. **Operations report:** open `/command-centre?cc=report` as `eyev1.admin@pulseos.local`. Switch the period to "Last 30
   days", pick a service, toggle Table, then Export → Enquiries and open the .xlsx.
2. **KPI definitions:** read them in §4. In particular, "Procedures completed" is dated by the first revenue event
   because no completion column exists. Decide whether you want a real `completed_at`.
3. **CRM field ordering:** Settings → CRM Fields → drag a field by its grip, refresh, then try the keyboard path.
4. **Time display:** set your laptop to another timezone and check that Journey Detail still shows IST times.
5. **Remaining P2s in §14:** decide on booking guards and login throttling before M7 reminders.

## 19. Recommended Next Development Wave

Ordered by dependency:
1. **Booking integrity:** past-time guard on create, plus doctor overlap detection. M7 reminders schedule from bookings.
2. **Security baseline for onboarding:** login throttling and a minimal AuditEvent table (exports, role changes,
   archive/restore).
3. **M7 appointment messaging:** templates, reminder rules and the notification outbox per the 2026-10-01 design
   contract §5. It runs in fixture mode until WhatsApp credentials exist.
4. **Settings: "system vs hospital" labelling** for stages and states. Show the fixed lifecycle read-only next to the
   configurable outcomes and follow-up types.
5. **Report follow-ups:**
   - A treatment `completed_at` column (additive migration) to replace the inferred completion date.
   - Previous-period comparison on the Operations KPIs.
   - The `appointments(journey_id)` index.
