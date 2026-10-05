# PulseOS — Foundation Convergence Ledger

Plan: [2026-09-15-pulseos-foundation-convergence-plan.md](2026-09-15-pulseos-foundation-convergence-plan.md)

Branch: `feature/pulseos-foundation-convergence`, from `worktree-pulseos-visual-reconstruction` @ `9980968`.
Worktree: `.claude/worktrees/pulseos-foundation-convergence`.

## Groups

Renumbered 2026-09-16 to match the "FOUNDATION CONVERGENCE + ENTERPRISE UX
COMPLETION MASTER LOOP" prompt's §48 execution order (adds a dedicated
Back-navigation group, splits UI work by page cluster). A-E are unaffected
(same letters, same scope in both prompts).

| Group | Scope | Status | Commit(s) | Tests | Review |
|---|---|---|---|---|---|
| A | Convergence workspace + baseline gate | done | c0faf9b, 12fbb38 | 129/129 pass | self |
| B | Migration/schema reconciliation | done | 05067f7 | 129/129 pass | self |
| C | Phone normalization + connector-mode reconciliation | done | 35bafeb | 138/138 pass | self, browser-verified |
| D | Unified acquisition ingestion | done | 70a8ce8 | 139/139 pass | self, browser-verified |
| E | Full first/last-touch attribution reconciliation | done | 89ac3a6 | 142/142 pass | self, browser-verified |
| F | Website / Meta / Google / GBP adapters ported | done | f5855f3 | 34/34 files, 202/202 pass | self, browser-verified |
| G | Campaign analytics + conversion feedback + INR fix + date filter + Campaign Detail route | done | d77646e, dd31243, 8596ec0 | 12/12 campaigns.integration + 6/6 UI + full suite green | self, browser-verified |
| H | Specialty Settings completion (reorder/required/options) | done | 9db42b4 | 24/24 specialty+leads integration, full suite 34/34 files 212/212 | self, browser-verified |
| I | Action/button/dead-control audit | done | c1766a9 | tasks + campaign-sync integration tests, full suite 35/35 files 216/216 | self, browser-verified (Doctor + Admin) |
| J | Design tokens/typography/geometry (J1) + PageHeader/Button/OverflowMenu (J2) + shared tables (J3) | done | 4cc6175, 4bdf429, c879753 | full suite 35/35 files 216/216, UI 6/6, design-tokens 4/4 | self, browser-verified |
| K | Navigation hierarchy + Back system | in progress (BackLink primitive done) | 1bbff04 | n/a (no web unit tests) | self, browser-verified |
| L | Inbox responsive reconstruction (L1) + Timeline visual refinement (L2) | done | 1b970c9, d56e06e | Playwright role-routing + no-overflow 18/18 pass | self, browser-verified (1280/390) |
| M | Patient 360 / Appointment / Treatment UX | mostly already correct, verified not rebuilt — see notes below | — | — | self, browser-verified |
| N | Command Centre / Leads / Campaigns UI | mostly already correct, verified not rebuilt — see notes below | — | — | self, browser-verified |
| O | Responsive / accessibility / motion | partial (spot-checked 1440/1280/1024/768/390 on flagship pages + Playwright no-overflow suite; full dedicated a11y/motion audit not run) | — | Playwright no-overflow 12/12 | self, browser-verified |
| P | E2E + screenshot package | done (26-file required set) | 6ab5f06 | Playwright: brain-review-screenshots 1/1, role-routing+no-overflow 18/18, crm-critical-flows 3/3, marketing-journey 3/3+1 skipped, command-centres 2/2, connector-checkpoint 1/1 (isolated) | self |
| Q | Final whole-branch review | not started | — | — | — |

## Resume point for the next session

Groups A, B, C, D, E, F, G, H, I are done and committed (`c0faf9b`,
`12fbb38`, `99476fb`, `05067f7`, `35bafeb`, `06a13fa` [seed fix], `70a8ce8`,
`89ac3a6`, `1bbff04` [Group K start], `f5855f3` [Group F], `d77646e` [Group
G part 1: campaign sync/GBP sync/conversion feedback], `dd31243` [Group G
part 2: INR compact formatting fix + campaign date filter], `8596ec0`
[Group G part 3: Campaign Detail route], `9db42b4` [Group H: Specialty
Settings completion], `c1766a9` [Group I: action/button/dead-control
audit]). Group K is started (BackLink primitive, wired into Patient 360 and
all 7 of its entry points, plus now Campaign Detail → Patient 360 as an
8th). Groups J, L, M, N, O, P, Q are **not started** — do not assume
otherwise from anything outside this ledger + `git log` after a context
compaction. **This is the end of the F→G→H→I execution block the last
session was asked to run — the branch is intentionally paused here for
Brain review, not merged, not deployed, not pushed.**

**What Group F actually built:** all 4 acquisition adapters
(`website-form.service.ts`, `adapters/meta-lead-ads.ts`,
`adapters/google-ads-lead-forms.ts`, `adapters/google-business-profile.ts`)
funnel through the same `lead-ingestion.service.ts::ingestNormalizedLead` →
`resolveOrCreatePatient` + `recordTouchpoint` path — no adapter duplicates
identity/attribution logic. GBP only implements `syncPerformance` (no
`patients`/`journeys` touch by construction — no FK column exists). Verified
live: cross-provider multi-touch (Meta then Google on one journey → first
touch stays Meta, last becomes Google), same-patient repeat-lead dedup,
idempotent duplicate webhook delivery. Also fixed a real bug in passing:
`whatsapp-meta-cloud.ts` was pinned to EOL Graph API `v23.0`; extracted a
shared `meta-webhook.ts` used by both WhatsApp and Meta Lead Ads, now on
`v25.0`.

**What Group G actually built:**
- `campaign-sync.service.ts` / `gbp-performance.service.ts` (adapter-agnostic
  sync orchestration, reused verbatim from the acquisition branch) +
  `POST /connectors/:id/sync-campaigns` / `sync-performance` routes.
- `conversion-feedback.service.ts` — consent-gated (`patients.marketingConsent`,
  checked *before* any write), idempotent per `journeyId:eventType`, wired
  into `treatment.service.ts`'s COMPLETED-status branch so treatment
  completion fires `TREATMENT_COMPLETED` with real attribution context.
- Fixed a real seed.ts FK-ordering bug this session's own work exposed
  (`conversionFeedbackEvents`/`gbpPerformanceMetrics` deletes were missing,
  crashing `db:seed` once those tables had reachable rows).
- Fixed the INR "₹46,666.667" bug: root cause was two local duplicate
  formatters (`SpendAtRisk.tsx`'s `money()`, `KpiStrip.tsx`'s `formatInr()`),
  not the shared `format.ts` (already correct). Added `formatInrCompact` as
  the one shared compact-context formatter; both components + `treatments/page.tsx`
  now use shared formatters, zero local duplicates.
- Added `dateFrom`/`dateTo` to `CampaignFilters`, filtered on
  `campaignTouchpoints.occurredAt` in `campaign.service.ts`, compact From/To
  inputs on the Campaigns filter bar.
- Built `/campaigns/[id]` (Campaign Detail): header + `MetricStrip` (reuses
  `getCampaignPerformance` with a `campaignId` filter) + an
  Attribution/Journeys table (reuses `listJourneys` with a `campaignId`
  filter — no new backend domain). Added `connectorMode` to
  `CampaignPerformanceRow` (same join pattern as `getSourcePerformance`) so
  FIXTURE-mode campaigns never read as LIVE on this page or the Campaigns
  list; exported the existing `ConnectorModeBadge` from
  `SourcePerformanceTable` as the one shared badge instead of a per-page
  duplicate. Campaigns list rows now link into the detail route via
  `withFrom(..., "campaigns")`; detail page's journey rows link into Patient
  360 via `withFrom(..., "campaigns")`; BackLink round-trips correctly
  (verified live in browser).
- **Known pre-existing issue, not caused by this session:** the Spend At
  Risk panel's `SectionHeading` (title + subtitle inline) wraps awkwardly in
  the Campaigns page's narrow right-column layout (`Spend At` / `Risk` split
  across lines, crowding the subtitle). Confirmed live in browser 2026-09-15
  during Group G verification. Not a regression from the `formatInrCompact`
  change (only the number formatting inside that component changed) —
  belongs to the deferred full visual-refinement pass, not this block.

**What actually exists now that F/G build on:**
- `domain/patient/identity.service.ts::resolveOrCreatePatient` — the one
  identity path. Every new ingestion source (Website/Meta/Google) should
  call this, never re-implement dedupe.
- `domain/acquisition/attribution.service.ts::recordTouchpoint` — the one
  touchpoint-writing path (first/last-touch aware). Every new ingestion
  source should call this too, passing a `TouchpointDetails` (medium/utm/
  external ids/click ids — the columns are already on `campaign_touchpoints`
  from Group B, just not populated by anything except manual leads yet).
- `domain/acquisition/attribution.service.ts::resolveCampaign` — find-or-
  create a `MarketingCampaign` by `externalCampaignId`, ready for adapter
  webhooks to call directly.
- `connectors.mode` (FIXTURE/SANDBOX/LIVE) is real and UI-honest (Group C) —
  any newly-ported adapter should default new connectors to `FIXTURE` and
  never claim LIVE without real credentials.

**What Group H actually built:**
- `UpdateSpecialtyInput.defaultJourneyType` wired through
  `specialty.service.ts::updateSpecialty` + `specialty.routes.ts`'s zod
  schema — the only backend gap; `sortOrder`/`required`/`archived`/`options`
  were already fully persisted by the existing `updateCustomField`.
- `apps/web/app/(app)/settings/page.tsx` rewritten: inline-editable Display
  label + Default Journey type (save-on-blur) atop each expanded specialty;
  each field row gets up/down `ChevronUp`/`ChevronDown` reorder buttons (swap
  two fields' `sortOrder` via two PATCH calls, no new endpoint), a
  Required/Optional checkbox, and — for `SELECT`/`MULTI_SELECT` fields only
  — a comma-separated Options editor; the create-field form also gained an
  Options input shown conditionally for those two types. All inline, no new
  route (per the standing "no `/settings/specialties/[key]` yet" decision).
- **New: server-side required-field enforcement.** `createLead` previously
  silently dropped any missing custom field value, required or not — the
  Add Lead form's HTML `required` attribute was the *only* enforcement, so a
  raw API call could bypass it entirely. `lead.service.ts::createLead` now
  checks every active required field for the specialty *before any write*
  and returns `{validationError: true, missingRequiredFields}`;
  `lead.routes.ts` turns that into `422 missing_required_fields`. This is a
  real gap this session closed, not something the master prompt named
  explicitly by file — flagged here since it's a behavior change to an
  existing endpoint's error surface (previously always 201 on valid zod
  shape; now can be 422 for a specialty with a required field an admin
  configured).
- Live-verified in browser end-to-end: renamed Ophthalmology's display
  label, reordered Laterality above Eye concern, marked Eye concern
  required, added a 4th Select option — Add Lead immediately reflected the
  new name, order, required asterisk, and option, with zero form-side code
  changes (`AddLeadDrawer.tsx` untouched). Demo DB reseeded afterward to
  restore canonical state.

**Discovered during Group H's full-gate run: a pre-existing, order-dependent
test flakiness, root-caused and NOT fixed (out of scope for this block).**
`post-care.integration.test.ts`'s first test permanently completes the
*only* seeded `SCHEDULED` treatment (`IVF Cycle 1`, ₹70,000, the sole
`status: "SCHEDULED"` literal in `seed.ts`) to exercise the post-care-task
side effect. `marketing-dashboard.integration.test.ts` separately hardcodes
`treatmentsCompleted === 4` against the seed's 4 literal `COMPLETED`
treatments. Vitest's file execution order is not stable run-to-run (no
`sequence.shuffle` configured, but order still varies) — when
`post-care` happens to run before `marketing-dashboard` in the same
`vitest run`, the shared Postgres DB has 5 completed treatments by the time
`marketing-dashboard` runs, and its hardcoded assertion fails, e.g.:
```
✓ src/__tests__/marketing-dashboard...  ← FAILS: expected 5 to be 4
```
Reproduced twice: one fresh-reseed run failed this way, the very next
fresh-reseed run (same code, same seed) passed 34/34 clean — confirming it's
run-order-dependent, not a regression from Group F/G/H's own changes (no
code this session touched either test file or the treatment-completion
logic). Root fix would be giving `post-care.integration.test.ts` its own
dedicated fixture treatment rather than reaching into shared seed state — a
test-infrastructure change outside Group H's scope, not applied here per
"do not weaken tests" (loosening `marketing-dashboard`'s assertion would
count) and not requested by the master prompt. Recommended follow-up for
whichever group next touches test infra.

**What Group I actually found and fixed** (audited via two parallel
Explore agents covering all 8 named pages, then fixed the real findings —
not a rewrite, just wire/hide):
- **Severe, pre-existing bug: "My Work" was completely broken for Doctor.**
  `GET /tasks` required `MANAGE_TASKS`, which Doctor doesn't have, but My
  Work is Doctor's *only* Operations nav item — every load 403'd, page
  showed nothing but `ErrorState`. Root cause: `MANAGE_TASKS` had no
  `VIEW_TASKS` sibling, unlike every other domain in `ROLE_PERMISSIONS`
  (`VIEW_PATIENTS`/`EDIT_PATIENTS`, `VIEW_APPOINTMENTS`/`MANAGE_APPOINTMENTS`,
  etc.). Added `VIEW_TASKS` (all 5 roles have it, including Doctor);
  `GET /tasks` now requires only that; every mutation
  (create/note/reschedule/reassign/complete) still requires `MANAGE_TASKS`
  via a per-route `preHandler` override. Doctor's My Work now loads and
  shows their own assigned tasks read-only (no Complete/+1 day/note
  controls, matching their lack of MANAGE_TASKS).
- **Dead "+ Add X" buttons for Doctor** on Patients, Appointments, My Work:
  `QuickCreateProvider` already gates *drawer mounting* by role
  (`canEditPatients`/`canManageAppointments`/`canManageTasks`, all
  `role !== "DOCTOR"`), but the trigger buttons on the pages themselves
  never checked the same thing — clicking silently did nothing for Doctor.
  Fixed by gating each button with `hasPermission(role, ...)` (the
  `EDIT_PATIENTS`/`MANAGE_APPOINTMENTS`/`MANAGE_TASKS` equivalent of the
  provider's boolean), using the pattern the existing `ROLE_PERMISSIONS`
  comment already documents: UI-side checks exist only to avoid dead
  controls, server enforcement is the real boundary and was already correct.
- **Appointments row/drawer actions silently 403'd for Doctor** (has
  `VIEW_APPOINTMENTS`, not `MANAGE_APPOINTMENTS`). `AppointmentList`
  already hid its action buttons when `onAction`/`onComplete` props are
  omitted — page now omits them for a non-managing viewer. Added a
  `readOnly` prop to `AppointmentDrawer` (packages/ui) that hides the
  entire actions footer the same way.
- **Treatments status-transition buttons** shown to Doctor
  (`MANAGE_TREATMENT` required, Doctor lacks it — advises via
  `RECORD_CONSULTATION_OUTCOME` instead) — now hidden for that role.
  Also: Decline/Cancel transitions were styled identically to
  Accept/Schedule (no danger visual separation) — now render in the same
  danger red used by the status badges.
- **nav.ts inconsistency**: Doctor's sidebar marked Appointments
  `implemented: false` ("Not built yet") even though the route exists and
  Doctor has `VIEW_APPOINTMENTS` — masking the dead-button bug above rather
  than fixing it. Now `implemented: true`; confirmed live the page is a
  genuinely safe read-only view for Doctor.
- **Integrations: real backend actions had no UI trigger at all.** The only
  button was "Refresh" (`queryClient.invalidateQueries` — a cache refetch,
  not a sync). `POST /connectors/:id/sync-campaigns` and `/sync-performance`
  (built in Group G) were unreachable from the UI. Added `Sync Campaigns`/
  `Sync Performance` buttons, shown only when the selected connector's
  `capabilities` include that sync type and only for `MANAGE_INTEGRATIONS`
  roles; live-verified both against the seeded Meta Lead Ads and Google
  Business Profile connectors ("Synced 2 records.", `LAST SYNC` updates).
  This backend endpoint had no test at all either — added
  `campaign-sync.integration.test.ts` (upsert-by-external-id, 422
  unsupported_capability, 404 unknown connector).
- **Inbox** (Quick Actions = exactly Book Appointment / Create Task / View
  Full Profile) and **Campaigns** (no Add Campaign button anywhere) — both
  audited clean, confirmed live, no changes needed.
- Live-verified as both Doctor (`doctor@pulseos.local`) and Hospital Admin
  (`admin@pulseos.local`): My Work loads for Doctor; Appointments loads
  read-only for Doctor (drawer shows only "View full patient context →",
  no action footer); Treatments shows an empty Actions column for Doctor
  but Accept/Decline(red)/Schedule for Admin; Patients has no Add Patient
  button for Doctor; Integrations' new Sync buttons actually sync live.

**Groups F→I are complete (previous block). This entry covers the
follow-on "ENTERPRISE UI/UX RECONSTRUCTION MASTER LOOP" block (started at
HEAD `5e23e0e`), which is also now substantially complete** — J1/J2/J3
(tokens/typography/geometry, PageHeader/Button/OverflowMenu, shared
tables), L1/L2 (Inbox responsive reconstruction, Timeline refinement), and
P (screenshot package) are done; M/N were largely *verified already
correct* rather than rebuilt (see below); O is a partial spot-check, not
the full dedicated pass the master prompt's §54 execution order reserves
for later.

**What Group J actually built:**
- **J1 (tokens/typography/geometry):** Inter was declared in
  `globals.css`'s `--font-sans` but never actually loaded (no `next/font`
  anywhere) — every page silently rendered in the OS system font the whole
  time. Now loaded via `next/font/google` in `apps/web/app/layout.tsx`.
  Synced `packages/design-tokens/colors.ts` with the `--color-chart-*`
  values `globals.css` already had but the TS source was missing. `Card`
  primitive radius `rounded-lg` (8px) → `rounded-xl` (12px) — the single
  highest-leverage fix since `Card` backs most panels app-wide. Sidebar
  240px → 224px, TopBar/Sidebar-header 56px → 64px, sidebar nav icons 16px
  → 18px. Fixed two dead controls found while touching `TopBar.tsx`: the
  global search redirected to `/patients?q=...` but Patients never read
  `q` (typed search silently vanished); the "Notifications" bell had no
  `onClick` at all (now visibly `disabled` with "coming soon" instead of a
  silent no-op).
- **J2 (PageHeader/Button/OverflowMenu):** `PageHeader` extracted from a
  byte-for-byte-identical header block already duplicated on
  Leads/Patients/My Work (confirmed via audit before extracting), then
  applied to Appointments/Treatments/Journeys/Campaigns/Settings/
  Integrations/Front Desk too, which previously had no in-page title at
  all. `Button` (primary/secondary/ghost/danger × sm/md) replaces 5+
  verbatim-duplicated className strings. `OverflowMenu` (ellipsis dropdown,
  danger items visually separated) — Treatments' status cell showed up to
  3 buttons per row before, now one primary forward action + the rest in
  the menu. Front Desk had two same-weight blue CTAs ("+ Add Lead"
  outlined-blue next to "+ New Appointment" solid-blue) — fixed to one
  primary + one quiet neutral secondary.
- **J3 (shared tables):** `Table`/`TableHead`/`TableBody`/`Tr`/`Th`/`Td` —
  a thin className wrapper, not a generic data/columns DataTable (Patients,
  Leads, Journeys, Treatments, Campaign Detail, Campaigns root, and
  Integrations' event log already agreed closely on the same rhythm before
  this; Campaign Detail/Campaigns root and Integrations had drifted —
  fixed). Row height `py-2` → `py-2.5`, deliberately short of generic
  "44-48px" guidance since CLAUDE.md sets `VISUAL_DENSITY=8`.

**What Group L actually built:**
- **L1 (Inbox):** the real bug — at typical laptop widths (1280-1440px),
  Patient Context's `hidden lg:block` (1024px breakpoint) never actually
  hid it at those widths, so all 3 fixed-pixel-width columns rendered
  together and squeezed the thread below the ~440px practical minimum.
  Fixed: Context is now a real 3rd column only at 2xl+ (1536px+);
  everywhere narrower it's a toggleable drawer via a new "Context toggle"
  button in the thread header (named in the master prompt's §32 but didn't
  exist before). Added mobile (<md) single-column list↔thread navigation
  with a Back arrow (didn't exist — the list was always rendered
  alongside the thread at every width). Found and fixed two more issues
  live-testing: the thread header's action row clipped off-screen at
  390px (now wraps), and Escape didn't close the new Context drawer (now
  does, matching `AppointmentDrawer`'s existing pattern).
- **L2 (Timeline):** every event used the same solid dot regardless of
  category — added a per-category icon + restrained background tint and
  surfaced `sourceChannel` inline. Patient 360's tabbed-vs-single-scroll
  question stays deferred per `docs/ui/pulseos-visual-reference-notes.md`'s
  existing ruling from a prior session — not reopened.

**M and N were audited live rather than rebuilt — found already correct:**
- Appointment Drawer (§24) already has exactly the target hierarchy: one
  full-width primary action in the footer, Reschedule/No-show/Cancel as a
  smaller secondary row. No changes made.
- Doctor Home already has the "Quick Stats" trio (§26) the master prompt
  asks for (`DoctorComponents.tsx`'s `DoctorQuickStats`, pre-existing).
- Front Desk's "Today's Patient Flow" (§25) is already the segmented
  multi-color bar the master prompt wants, not a single-color progress bar
  (`PatientFlowBoard.tsx`, pre-existing).
- Command Centre's row structure (§15) already matches: one connected KPI
  strip, 8-col chart + 4-col radial, 3 equal cards below — verified live at
  1440/1024/768px, tablet correctly stacks to one column.
- **Deliberately NOT done: Command Centre's Journey Performance chart is
  still a grouped bar chart, not the funnel/drop-off visualization §16
  asks for.** This exact tension was already reviewed and resolved in
  `docs/ui/pulseos-visual-reference-notes.md` ("we use a grouped bar chart
  — a reasonable adaptation, not rebuilt") during an earlier session's
  visual pass. Treated that as the standing decision rather than
  reopening a real charting rebuild inside this pass — flagged for Brain
  review, not silently skipped.
- **Deliberately NOT done: My Work's tabs (§27) have no count badges.**
  Would need a new per-view-counts aggregation the backend doesn't expose
  today — adding it is backend work, not a pure UI change, and this block
  was scoped to UI.

**Group O is a spot-check, not the dedicated pass §54 reserves for
later:** verified no horizontal overflow via the existing Playwright
`no-overflow.spec.ts` (12/12, every major role × desktop/tablet/mobile) and
manually inspected Command Centre/Inbox at 1440/1280/1024/768/390. Did not
run a dedicated accessibility audit (focus-visible, ARIA labels on
icon-only controls, screen-reader chart summaries, `prefers-reduced-motion`
handling) beyond the Escape-key fix found live-testing Inbox, and did not
do a systematic motion-timing audit beyond confirming the existing global
`* { transition-duration: 120ms }` rule (already within the target
100-160ms micro-interaction range) is still in place.

**Suggested next task for a future session: Group Q (final whole-branch
review)**, or finish Group O's dedicated accessibility/motion pass, or
revisit the two deliberate M/N deferrals above if Brain review calls for
them. Group J (in this ledger's original F→I-era row) is complete —
superseded by this entry, not a separate outstanding task.

**Group K status:** BackLink now has 8 wired entry points (Patient 360's 7
+ Campaign Detail → Patient 360, added in Group G). Campaign Detail itself
now exists (`/campaigns/[id]`, built in Group G) with its own BackLink to
`/campaigns`. Settings/specialty-editor still has no dedicated detail route
(deliberately, per the standing "no `/settings/specialties/[key]` yet"
decision) — Back does not apply there by design, not by omission.

**Group M's INR 3-decimal issue is now FIXED (done in Group G, not held for
Group M).** Root cause: two local duplicate formatters
(`SpendAtRisk.tsx`'s `money()`, `KpiStrip.tsx`'s `formatInr()`), not the
shared `format.ts`. Fixed via new shared `formatInrCompact`; see Group G
section above for detail. Verified live: Campaigns page now shows
`₹1,56,000`/`₹75,000` etc., never a 3-decimal value.

**Group G's connector-mode scope gap is now closed.** The Campaigns page
now shows `ConnectorModeBadge` (same shared component `dashboard.service.ts`
uses for Command Centre) on both the Campaigns list and Campaign Detail —
`campaign.service.ts::getCampaignPerformance` now joins `connectors.mode`
the same way `getSourcePerformance` does.

## Rulings

- Attribution model, migration strategy, Exotel/Superfone, `/treatment` redirect, AI
  runtime scope: see plan doc "Key rulings" — carried here as binding for this branch.

## Group B — what was actually done

Ported the additive acquisition-branch schema into `schema.ts` (no drops, no
renames, no column-type changes): `tenants.default_phone_region`;
`marketing_campaigns.connector_id`/`external_account_id` + a
`(tenant_id, external_campaign_id)` unique index; 14 new nullable columns on
`campaign_touchpoints` (medium/utm_*/external_*/gclid family);
`connectors.mode` (new `connector_mode` enum FIXTURE/SANDBOX/LIVE, default
FIXTURE); `connector_type` gains `ACQUISITION`; `connector_capability` gains
8 acquisition-related values; four new tables
(`conversion_feedback_events`, `gbp_performance_metrics`,
`connector_disposition_mappings`, `connector_config_audit_events`).
Updated `packages/types` (`ConnectorMode`, `ConnectorRow.mode`,
`SourcePerformanceRow.connectorMode`, widened `ConnectorType`/
`ConnectorCapability`), `connector.service.ts` (`toRow` now returns `mode`),
`dashboard.service.ts` (`getSourcePerformance` now joins the owning
connector's mode per campaign), and the Integrations page's
type/icon/label maps (added `ACQUISITION`).

Generated migration `0008_brave_bulldozer.sql` via `drizzle-kit generate` —
pure `CREATE TYPE`/`ALTER TYPE ... ADD VALUE`/`CREATE TABLE`/
`ALTER TABLE ... ADD COLUMN` statements, linear after this branch's `0007`.
Verified by migrating a throwaway clean database
(`createdb pulseos_migration_test` → `db:migrate` → `db:seed` → `dropdb`)
end to end with no errors.

**Known gap, recorded rather than silently patched:** the shared local
`pulseos_dev` database (used by every worktree's `pnpm dev`) already has 13
applied migrations in `drizzle.__drizzle_migrations` — more than any single
branch's own migration folder — meaning a prior session hand-applied a
combination of branches' migrations directly against it outside of git
history. Its actual column/table shape already matches what this branch's
`schema.ts` + migration `0008` produce (verified column-by-column:
`connectors.mode`, `campaign_touchpoints` new columns,
`tenants.default_phone_region`, all four new tables already present). The
full API test suite (129/129) and a browser-verified `pnpm dev` both run
correctly against it as-is. However, `pulseos_dev`'s migration journal does
**not** contain an entry matching this branch's `0008` file (different
filename/hash than whatever combination produced its current state), so
running `pnpm db:migrate` against `pulseos_dev` from this branch **will
currently fail** with "already exists" errors if attempted. This is a
pre-existing operational-ops gap in the shared dev database, not introduced
by this session — recommended follow-up (not done here, out of scope for a
schema-reconciliation checkpoint): rebuild `pulseos_dev` from a clean
`db:migrate`+`db:seed` on this branch once it's the adopted lineage, so the
journal and the branch agree again.

## Known blockers

- See "Group B — what was actually done" above re: `pulseos_dev`'s
  migration journal vs. this branch's `0008` — not a functional blocker
  (server runs fine), but `db:migrate` should not be run against the shared
  dev DB from this branch until reconciled.

## Baseline gate results

Ran 2026-09-15 in `.claude/worktrees/pulseos-foundation-convergence` (fresh `pnpm install`):
- `pnpm lint`: PASS (2/2 tasks, 1 cached).
- `pnpm typecheck`: PASS (7/7 packages, 6 cached).
- `pnpm test`: initially 2 pre-existing failures unrelated to convergence
  (confirmed identical on untouched `pulseos-visual-reconstruction` worktree —
  `encryption.test.ts` missing ambient `CONNECTOR_ENCRYPTION_KEY` under bare
  `vitest run`, `KpiStrip.test.tsx` querying a now-removed nested `<button>`
  after the `MetricStrip` connected-cell refactor). Both fixed (commit
  `12fbb38`). Re-ran fresh after `pnpm db:seed`: **21/21 files, 129/129 tests
  PASS**.
- `pnpm build`: PASS (web + api, 18 routes generated including `/leads`,
  `/campaigns`, `/settings`, `/patients/[patientId]`).
- DB reseeded again after the test run (integration tests mutate shared
  Postgres state; a repeat `pnpm test` run without reseeding shows spurious
  failures on exact-count assertions — this is test-suite behavior, not a
  bug, and is expected of every fresh baseline/verification pass in this
  repo, not just this one).

## Group B — schema reconciliation scoping (found before writing code)

Read both branches' `schema.ts` directly rather than assuming the audit's
"conflict" framing. Actual finding: **the campaign_touchpoints/marketing_campaigns
schema itself has NO real conflict** — acquisition's version is a strict
superset of visual-reconstruction's (14 additional nullable columns on
campaign_touchpoints: medium/utm_*/external_*/gclid family; 2 additional
columns + 1 unique index on marketing_campaigns). Same for `connectors`
(acquisition adds one `mode` enum column) and `connector_type`/
`connector_capability` enums (acquisition adds "ACQUISITION" + 8 capability
values, purely additive). The real conflict the audit flagged is entirely in
the **service layer**: visual-recon's `lead.service.ts` has the only write
site for `campaign_touchpoints` and always writes `touchType: "first_touch"`;
acquisition's `attribution.service.ts` (`recordTouchpoint`/
`getAttributionSummary`) has the correct first-then-last-touch logic already
built and tested. Plan: port `attribution.service.ts` + `touchpoint.ts`
close to verbatim, replace the one call site.

Phone normalization is a **real** conflict, correctly identified by the
audit, but narrower than feared: acquisition's richer `identity/phone.ts`
(libphonenumber-js, E.164, tenant-region-aware) is currently only wired into
the *connector* ingestion path (`patient-identity.service.ts`), not into
acquisition's own manual flows (acquisition branch has no Leads UI at all).
Visual-recon's simpler `patient/phone.ts` (hand-rolled, India-only, bare
10-digit key) has exactly 2 call sites (`lead.service.ts`,
`patient.service.ts`). Ruling: adopt E.164 as canonical for *all* entry
points (manual, website, Meta, Google) — required for Group D's "one
identity resolution path" to be coherent, and the only way a manually-added
patient and a later Meta-sourced touch for the same person actually match.
`tenants.default_phone_region` (text, default `'IN'`) is a new additive
column. Since all current data is fictional demo/seed data (CLAUDE.md
security rule), no backfill migration is written for existing rows — this
is recorded here as a deliberate scope decision for a *pilot-readiness*
follow-up once real tenant data exists, not for this checkpoint.
