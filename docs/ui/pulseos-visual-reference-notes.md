# PulseOS Visual Reference Notes

Written extraction of the 5 reference images used for the visual reconstruction
pass (2026-09-13). These are our own observations, not the source images —
committed intentionally so the design direction survives context compaction.
The actual image files are not committed (copyrighted, and no local file path
was available to copy them from this session's attachments).

Source images (as attached to chat, not stored in this repo):
1. **PRIMARY** — PulseOS Healthcare Dashboard Showcase (9-panel collage)
2. DealDeck dashboard — premium blue/white panel styling
3. Segmented radial ("Financial Objections 184 [64%]")
4. Visiora dashboard — dense KPI row + analytics composition
5. Setter dashboard — actionable queues + conversion-funnel bar

## Cross-cutting patterns (seen in 2+ references)

- **KPI strips are one connected panel** with internal dividers, not floating
  cards (DealDeck, PulseOS, Visiora). PulseOS's cells additionally carry a
  small trend indicator per cell (▲/▼ + % vs last period, green/red) — our
  `MetricStrip` doesn't have this yet.
- **Flow/funnel visualizations are a segmented, multi-color horizontal bar**
  with the count printed under each segment and (in Setter) a drop-off %
  between segments — not a single-color progress bar with a separate legend
  row below it. Seen in PulseOS Front Desk ("Today's Patient Flow") and
  Setter (Convos→Qualified→...→Closed). This is a real, recurring pattern
  worth a shared component.
- **Segmented radial** = concentric rounded-cap arcs, each with its own pale
  "track" completing its own arc's span (not one shared 100% track), soft
  gaps between segments, center label + value, legend as a list beside (not
  below) the ring. Matches what `SegmentedRadial.tsx` already does.
- **Grouped-reason counts vs. named lists**: some panels (PulseOS "Pending
  Confirmation", "No-show Recovery") show counts grouped by reason ("3 New
  enquiries", "2 Callback requests") rather than named patient rows, while
  adjacent panels ("Recent Arrivals") do show named rows. The choice depends
  on whether the panel is meant for triage-at-a-glance vs. action-on-a-person.
- **Table actions are icon/ellipsis-driven**, not inline colored buttons —
  status/priority conveyed via small pill badges, "Next Action" as a single
  small link/icon-button per row, not a button bar.
- Palette across all references: cool blue-white backgrounds, white cards
  with soft borders and minimal shadow, blue primary with green=positive /
  red=negative /amber=caution deltas, 12–16px radii, dense but calm spacing.

## PRIMARY collage — page-by-page

### 01 Login
- Split ~62/38 (not 58/42), left = flat/lightly-gradient deep blue brand
  canvas, right = white auth panel.
- Left: wordmark top-left, headline, subtext, then **Acquire / Convert /
  Grow as 3 horizontal columns** (icon-square above bold label above short
  description) — not stacked vertical rows. Bottom: a **stats row** ("10K+
  Patients", "25+ Clinics", "98% Satisfaction") instead of badge chips.
- Right: "Welcome back" / "Sign in to your PulseOS account", Email field,
  Password field (show/hide eye icon), Remember me + Forgot password on one
  row, full-width blue "Sign In →" button, "or" divider, Google sign-in
  button, footer help text. **Not implementing Google sign-in** — no real
  OAuth backend and section 24 of the brief explicitly excludes new
  integrations; noted as a known, deliberate gap.

### 02 Admin Command Centre
- Sidebar: white (SUPERSEDED 2026-09-29 by the Blue Finish — now blue-navy `.app-sidebar`), grouped sections (MAIN/PATIENTS/OPERATIONS/GROWTH/SYSTEM),
  active item = light-blue pill + bold blue text. **This already matches**
  our current Sidebar — confirmed via fresh screenshot, not assumed.
- KPI strip: 6 connected cells, each with a trend delta (▲/▼ %, colored).
- Row 2: 8-col "Patient Journey Performance" chart (line/area style in the
  reference; we use a grouped bar chart — a reasonable adaptation, not
  rebuilt) + 4-col "Journey Health" radial with legend beside the ring
  (already matches).
- Row 3: 3 equal cards — Attention Required (count badge + reason rows),
  Patient Flow Today (small numeric columns), Top Sources by Revenue
  (already matches our compact `SourcePerformanceTable`).

### 03 Doctor Home
- KPI strip (already matches pattern). "Today's Patient Queue" with a
  highlighted "Next Patient" row + "See Now" button, then plain list rows.
  "Today's Flow" radial with legend beside it (already matches). A
  **"Quick Stats" trio** below the radial (Awaiting Outcome / Treatment
  Follow-ups / Post-care Reviews as compact numbers) — not currently present
  as a compact block (we show a full list instead).

### 04 Front Desk
- KPI strip (already matches). **"Today's Patient Flow" is a segmented
  multi-color bar** (Arrivals/Checked In/Waiting/With Doctor/Completed),
  not a thin single-color progress bar — this is the clearest, highest-
  confidence gap on this page. "Waiting Queue" numbered rows with wait-time.
  "Recent Arrivals" (named), "Pending Confirmation" / "No-show Recovery"
  (grouped reason-counts, not named rows) as a 3-col row.

### 05 My Work
- Compact tabs with count badges (All/Overdue 8/Due Today 18/Upcoming/
  Treatment Decisions 6/Post-care 5/Callbacks 10). Table: Patient/Journey/
  Reason/Due/Priority/Next Action, Next Action as a small link not a button.

### 06 Patients
- Search + Branch/Stage filters + Add Patient + Export. Table matches our
  columns closely. Pagination footer ("Showing 1–6 of 348", numbered pages)
  — we don't paginate (20 demo patients, no pages needed functionally, but
  worth a simple count line for parity).

### 07 Patient 360
- Header with avatar/name/demographics/active-journey pill/owner/start date.
  **Tabbed content** (Overview/Timeline/Appointments/Treatments/
  Communications/Documents/Billing) rather than one long scroll — our
  current page shows Timeline + Journeys + Acquisition all at once. Given
  the brief calls this out as "should be one of the best screens," and our
  current approved structure (Timeline-dominant left / Journey context
  right / Acquisition below) is explicitly "approved" per section 18 of the
  completion-loop prompt, tabs are a bigger restructure than this pass's
  budget supports without risking the approved layout — deferred, noted for
  Brain review.

### 08 Inbox
- 27/48/25 already matches our split. Right panel "Quick Actions" as a
  compact list (Book Appointment / Create Task / View Full Profile) —
  verify against current implementation before changing.

### 09 Appointments
- Tabs + filters + table with status pills and an ellipsis actions menu
  (not inline buttons) — check against current implementation.

## Responsive assumptions (from the collage's implied grid, not shown
directly at narrow widths)
- Desktop-first design; no dedicated mobile mockup in the references.
  Existing mobile-drawer sidebar pattern from the last pass stands.

## Non-goals confirmed by comparison
- (SUPERSEDED 2026-09-29: the Blue Finish deliberately moved the sidebar to blue-navy and tinted the page canvas; content surfaces stay white.) Previously: do not switch the sidebar to dark navy — the reference's white/light
  sidebar is what we already have.
- Do not add Google OAuth, new backend modules, or new attribution logic
  (explicitly out of scope per the completion-loop brief).
