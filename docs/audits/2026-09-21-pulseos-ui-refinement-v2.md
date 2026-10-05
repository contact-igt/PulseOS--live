# PulseOS — UI Refinement V2 Audit (Command Centre precision pass)

Prompt identity: "PULSEOS — UI REFINEMENT V2 + FUNCTIONAL COMPLETION MASTER LOOP" (2026-09-21).
Scope of this document: §06 (visual defect table) + §07 (Command Centre precision pass) only.
The master prompt's remaining ~30 sections (cross-product pass on 12 more pages, motion pass,
accessibility pass, functional-completion workflow testing, final Opus review) are **not** covered here —
see the session's final report for an honest split of done vs. not-done.

## Why this scope, not the full 73→37-section sweep in one pass

§07 is explicit: *"This is the FIRST implementation target. Do not move on until it is genuinely
refined."* §33 requires an independent review after Command Centre before continuing to the rest of the
product. Given `git` is still blocked (Xcode license, see below) and there is no way to checkpoint a
large multi-page mutation pass, the responsible increment is: verify the specific complaint (Command
Centre "misalignment"), fix what's real, prove it with fresh measurement, and stop at the gate the prompt
itself defines — not push forward into 12 more pages of changes with no commit safety net.

## Git status

`git status` still fails with the unaccepted Xcode license (`sudo xcodebuild -license` required — needs
the user's own terminal/password, not runnable by the assistant). All work in this document exists only
as uncommitted changes in `.claude/worktrees/pulseos-foundation-convergence`, compounding the risk already
flagged at the end of the prior (2026-09-21 enterprise-ui-loop) session. This remains the single biggest
open risk to the work done across both passes.

## What the human's "still see misalignment" complaint actually was

The prior session's report claimed Command Centre's panel alignment and the Journey Health radial's
centering were correct. Both claims were re-verified this pass with live `getBoundingClientRect()` /
`getBBox()` measurement and **held up**:

- Row 2/3/4 panel headings land at identical y-coordinates within each row (e.g. row 3 headings all at
  `y=555.5`), identical padding (`16px` top/left) — pixel-precise, not eyeballed.
- Journey Health radial: every ring shares `cx=cy=110`; the "20%"/"Conversion" text block's bbox center is
  `(110.0, 110.0)` — exact match.

So the complaint was real, but not where the prior report (or this prompt's own §11 hypothesis) expected
it. The actual defects were all **responsive** — present specifically at 1024px (and, to a lesser degree,
1280px), invisible at 1440px (where the prior session did most of its verification) and invisible at 768px
(where panels stack to 1 column and have room again). That 1024px gap was already named as an open risk in
the prior session's own ledger ("1024px breakpoint not re-verified live after the palette/layout fixes").

## Defect table

| # | Page/Area | Category | Evidence | Root cause | Fix |
|---|---|---|---|---|---|
| 1 | Command Centre → "Top Campaigns by Revenue" panel | TABLES / RESPONSIVE | `getBoundingClientRect()` at 1024px: table right edge at x=1012 vs. card's padded content edge at ~984 — a 28px overflow silently clipped by the card's `overflow-hidden`. Screenshot showed "ROAS" header cut to "ROA". | `SourcePerformanceTable`'s compact table used `table-layout: auto` (the default) with un-wrapped numeric cells (`tabular-nums`, no `whitespace` control). Auto layout sizes columns to unwrapped content's intrinsic width, which can exceed the container even with `w-full` — this is a real CSS behavior, not a Tailwind misconfiguration, and the visual truncation classes on the campaign-name span don't participate in table column sizing under `auto` layout. | `table-layout: fixed` + explicit `<colgroup>` percentage widths (52/26/22) in compact mode, so declared widths — not content — are authoritative at any panel width. `packages/ui/src/SourcePerformanceTable.tsx`. |
| 2 | Command Centre → "Patient Journey Performance" / "Patient Flow Today" headings | TYPOGRAPHY / HIERARCHY | Screenshot at 1024px: "Patient Journey Performance" wrapped mid-phrase into "Patient Journey" / "Performance"; "Patient Flow Today" wrapped into "Patient Flow" / "Today". | Shared `SectionHeading` primitive put title (`h2`) and subtitle in one `flex items-baseline` row with no wrap control — when the panel narrows, the browser doesn't wrap between title/subtitle first, it word-breaks the heading itself. | Made the container `flex-wrap`, added `whitespace-nowrap` to the title so it never breaks; the subtitle now drops to its own line under the title when tight. Generic fix in the shared primitive — every consumer benefits, not a per-page patch. `packages/ui/src/primitives.tsx`. |
| 3 | Command Centre → Journey Health radial legend | TYPOGRAPHY / RESPONSIVE | Screenshot + DOM at 1024px: every legend label truncated to 3-4 characters + ellipsis ("Con...", "App...", "Atte...", "Tre...") — unreadable. | `SegmentedRadial`'s svg+legend row switched to side-by-side at the **viewport** breakpoint `sm:` (640px), not based on the panel's own rendered width. At 1024px viewport the Journey Health panel itself is only ~300px wide (it's the 4/12 column of a 1.5fr/1fr grid), well under what svg+legend side-by-side needs — but the viewport-based breakpoint had already switched it to row mode, leaving the legend a sliver. | Replaced the viewport breakpoint with a **container query** (`@container` on the Card, `@[360px]:flex-row` on the inner flex) so the layout responds to the panel's actual width. Below 360px of container width it now stacks (legend gets full card width, no truncation); at/above it, side-by-side as before. Verified this doesn't regress 1440/1280/768. Also added a `title` attribute to each legend button so a still-truncated label (rare, only in very narrow embeds) is at least recoverable on hover. `packages/ui/src/SegmentedRadial.tsx`. |

Deliberately **not** treated as defects (checked, found to be intentional/correct):
- Row-level panel alignment and radial centering (see measurement above) — the prior session's claims here
  were correct.
- Patient Flow Today's thin colored slivers for zero-count stages — documented, deliberate design (a
  0-width bucket would read as "doesn't exist" rather than "nothing here yet"). `PatientFlowBoard.tsx`.
- Journey Performance panel + Journey Health radial showing overlapping funnel data in two visual forms —
  redundant-looking but is the layout §08 itself specifies (8/12 + 4/12 in row 2); not unilaterally removed.
- Integrations connector list's capability pills — already compact (2 pills + "+N" overflow per row), not
  the 4-5-pill soup the prior ledger's "remaining issues" note described. No change needed.

## Verification

- `pnpm --filter @pulseos/ui typecheck` — clean.
- `pnpm --filter web typecheck` — clean.
- `pnpm run lint` (turbo, all 7 packages) — clean.
- `pnpm run typecheck` (turbo, all 7 packages) — clean.
- Live re-check in browser at 1440 / 1280 / 1024 / 768 after each fix — all three issues confirmed
  resolved at 1024 (their failure point), no regression at the widths that were already correct.
- Before/after screenshot pair: `review-artifacts/enterprise-ui-refinement-v2/before/` and `.../after/`
  (same Playwright spec, run before and after the three fixes).

## Not done this pass (carried to next iteration)

- Full before/after comparison `index.html` (screenshots captured both sides; index page not built yet).
- Cross-product pass (§15-21: Login, Shell, Leads, Patient 360, Front Desk, Doctor Home, My Work,
  Appointments, Treatments, Inbox, Campaigns, Settings) — only spot-checked via screenshot for this
  document, not measured/refined.
- Functional completion pass (§22), stale-data audit (§23), dead-control audit (§24).
- Motion/interaction pass (§25) and accessibility pass (§26) — still deferred from the prior session too.
- Full Playwright regression run (only the two new screenshot specs were run this pass).
- Independent Opus review.
