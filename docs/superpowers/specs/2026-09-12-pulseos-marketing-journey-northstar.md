# PulseOS Marketing → Patient Journey North Star (Addendum)

- **Status**: Binding addendum to [2026-09-12-pulseos-greenfield-foundation-design.md](2026-09-12-pulseos-greenfield-foundation-design.md). Supersedes any prior dashboard/page decision that would make PulseOS read as a generic hospital CRM.
- **Date**: 2026-09-12, revised 2026-09-12 (Hospital Operations Checkpoint) — canonical tagline widened; see note below.
- **Scope**: product purpose, dashboard hierarchy, attribution definitions. Does not change the locked architecture decisions (greenfield `apps/web`/`apps/api`, dedicated `Journey` entity) from the base spec.

## Canonical tagline (revised)

> **"PulseOS is the Patient Engagement and Revenue Intelligence Operating System for Indian hospitals — connecting every enquiry, conversation, appointment, consultation, treatment and follow-up into one continuous patient journey."**

Supporting value proposition:

> **"Know where every patient came from, what happened next, what needs attention, and what revenue was generated."**

**Revision note**: the original tagline ("PulseOS is made for Indian hospitals to cut back your marketing expense") was too narrow — it framed marketing efficiency as the entire product rather than one major benefit of it. Marketing attribution, Spend At Risk, and ROAS reporting are **not weakened or removed** by this revision — they remain a first-class layer (§"The four core questions" and the Admin Command Centre's Business/Growth section, below), just no longer the sole reason PulseOS exists. The product is the full operational loop — enquiry → patient → journey → follow-up → appointment → check-in/waiting → consultation → treatment decision → treatment → post-care → next action — with source/cost/conversion/revenue as one continuous thread running through it, not a separate analytics product bolted on top.

## Purpose

PulseOS exists to give a hospital one continuous, role-aware operating picture of every patient's journey — from first enquiry through follow-up, appointment, consultation, treatment, and post-care — while keeping source, acquisition cost, conversion, and revenue visible throughout. CRM and operational workflows (Patients, Journeys, Timeline, Tasks, Appointments, Treatment, Inbox) are the product; marketing attribution is the layer that explains where the demand behind that operational work came from and what it's worth.

PulseOS is **not** primarily "patient management software" in a generic sense, and it is **not only** a marketing analytics dashboard. It is a **patient engagement and revenue intelligence operating system for Indian hospitals** — real daily-use screens for reception, coordinators, and doctors, with marketing/revenue context layered throughout rather than concentrated in one dashboard. It is not a conventional sales CRM and not a full HIS/EMR.

## The four core questions

Every dashboard and flagship screen answers a subset of:

1. **Where did the patient come from?** (source/campaign attribution)
2. **What happened to the patient?** (journey stage, appointment, consultation, treatment progression)
3. **Where did we lose the patient?** (funnel drop-off, spend at risk)
4. **What should the hospital do next?** (action queue, next action)

## System relationship

```
Marketing Spend → Patient → Journey → Appointment → Consultation → Treatment → Revenue
```

## The operational loop (widened scope, Hospital Operations Checkpoint)

The product's actual daily-use surface is this full loop, with source/cost/conversion/revenue as a continuous thread running through every stage rather than a separate dashboard:

```
Enquiry → Patient → Journey → Follow-up → Appointment → Check-in/Waiting →
Consultation → Treatment Decision → Treatment → Post-care → Next Action
```

Every stage is a real screen someone uses daily (Patients, Journeys, Tasks/My Work, Appointments/Front Desk, Doctor consultation outcomes, Treatments, Inbox) — not a report about the stage. Marketing attribution answers "where did this demand come from and what is it worth," layered onto that operational spine, not a parallel product.

## Role value (who contributes what to the same goal)

- **Hospital Admin**: sees both business/growth (spend → acquisition → conversion → treatment → revenue → ROAS → spend-at-risk) and operations (today's appointments, waiting load, no-shows, overdue follow-ups, tasks due, treatment decisions pending, post-care overdue) in one Command Centre.
- **Front Desk**: owns the daily arrivals/check-in/waiting/no-show-recovery loop — the operational surface that protects acquisition spend from being wasted through slow first contact, missed appointments, unrecovered no-shows.
- **Patient Coordinator / Counsellor**: owns "My Work" — recovers pending treatment decisions, callbacks, follow-ups, high-value opportunities, at-risk journeys, and drives post-care next actions to completion.
- **Doctor**: does not see marketing/revenue data by default. Owns the consultation → outcome → treatment-decision moment — closing the loop that turns "we spent money and got an enquiry" into "we spent money and got a completed treatment," and turns "we saw the patient" into a scheduled next action.

## Attribution MVP (explicit, transparent — not multi-touch ML)

Tracked: **first touch**, **last touch**, campaign/source association per Journey (`CampaignTouchpoint`).

Per campaign, computed from persisted data only:

- `Marketing Spend` = `MarketingCampaign.spend_amount`
- `Enquiries` = count of Journeys with a touchpoint on that campaign
- `Appointments` = count of those Journeys with ≥1 Appointment
- `Consultations` = count of those Journeys with a completed Appointment
- `Treatment Advised` = count of those Journeys with a `ConsultationOutcome` of `TREATMENT_ADVISED`
- `Treatment Completed` = count of those Journeys with a `TreatmentOpportunity.status = COMPLETED`
- `Attributed Revenue` = `SUM(RevenueEvent.amount)` for those Journeys

Derived (documented formulas, unit-tested, never estimated in the UI layer):

- `Cost per Enquiry` = `spend / enquiries`
- `Cost per Appointment` = `spend / appointments`
- `Cost per Consultation` = `spend / consultations`
- `Cost per Completed Treatment` = `spend / treatments_completed`
- `ROAS` (marketing efficiency) = `attributed_revenue / spend`

All divisions guard against a zero denominator (return `null`/"—", never `Infinity` or `NaN`, in both the service layer and the UI).

## Spend At Risk vs. Confirmed Marketing Leakage

Two distinct concepts — never conflated:

- **Spend At Risk**: acquisition spend allocated to a **currently recoverable** journey with an operational failure requiring action today (never contacted, overdue first contact, missed follow-up, no-show awaiting recovery, treatment decision awaiting overdue follow-up). This is the prototype's primary focus.
- **Confirmed Marketing Leakage**: acquisition spend linked to a journey **definitively lost** to operational drop-off (e.g., `stage = lost`). Tracked as a concept in the schema/formulas but not a separate dashboard panel in this checkpoint.

**Allocation approximation** (documented, not formal accounting): a Journey's allocated acquisition cost = `campaign.spend_amount / campaign.enquiry_count` (the campaign's average cost-per-enquiry) for the campaign it's attributed to via first-touch `CampaignTouchpoint`. Journeys with no campaign touchpoint (organic/walk-in/referral) are not counted toward spend-at-risk, since there is no spend to protect.

`Total Spend At Risk` = `SUM(allocated acquisition cost)` over Journeys currently in an at-risk category (see admin dashboard panel below). Never call an active, recoverable journey "wasted" or "marketing waste" in copy — the reserved term for that is "Spend At Risk"; "waste" language is reserved for `Confirmed Marketing Leakage` only, and is not surfaced as a labeled panel in this checkpoint.

## Dashboard hierarchy (Admin Command Centre)

The Command Centre now balances two equal halves — **Business/Growth** and **Operations** — rather than being marketing-first:

**Business / Growth**
1. **Executive strip**: Marketing Spend, Enquiries/Acquired Journeys, Consultations, Completed Treatments, Attributed Revenue, ROAS, Spend At Risk — compact, not seven giant cards.
2. **Journey funnel** (flagship): Enquiry → Contacted → Appointment Booked → Attended → Consulted → Treatment Advised → Treatment Scheduled → Treatment Completed, with count/conversion/drop-off and cost-per-stage-outcome. Biggest drop-off highlighted. Stage click drills into filtered Journeys.
3. **Spend At Risk** (signature panel): categories (Uncontacted, Overdue follow-up, No-show recovery, Treatment decision pending, Post-consultation follow-up overdue) each showing journey count + allocated spend + severity/age, plus a total. Category click drills into filtered Journeys, actually filtered.
4. **Source/Campaign performance**: sortable table of Spend, Enquiries, Appointments, Consultations, Treatments, Revenue, ROAS per source/campaign — deliberately exposes cases like "cheap enquiries but poor treatment conversion."

**Operations**
5. **Today strip**: appointments today, waiting now, no-shows, overdue follow-ups, tasks due, treatment decisions pending, post-care overdue.
6. **Patient flow**: waiting / checked-in / with doctor / consultation complete / follow-up required.
7. **Action queue**: uncontacted high-intent, overdue callbacks, no-shows needing recovery, treatment decisions pending, overdue post-care — connects insight → patient/journey → action.

**Team** (workload, overdue-by-person) stays secondary, below both halves. Every card drills into the matching working queue (Journeys, Tasks, or Appointments) — not a static report.

## Doctor Command Centre (unchanged purpose, reaffirmed)

No marketing spend/ROAS ever shown to a doctor. The doctor's contribution is completing patient-journey outcome data: today's appointments, waiting/checked-in, next patient, consultations awaiting outcome, low-friction outcome actions (Consultation Completed / Treatment Advised / Decision Pending / Follow-up Required / No Treatment Required). Each action writes `ConsultationOutcome` (+ `TreatmentOpportunity`/`Task`/`TimelineEvent` as applicable) — this is the mechanism by which marketing attribution becomes treatment attribution.

## Patient 360 — marketing context

Header carries a compact **Acquisition / Value** context (source, campaign, first touch, attributed acquisition cost, estimated treatment value, attributed revenue when available) alongside the existing clinical-operational context (journey, stage, owner, next action, appointment, doctor, treatment status). Financial context is compact and never dominates the care workflow visually.

## Journeys page — analytics context

Beyond the record table, top context surfaces Active Journeys, Appointments pending, Consultations pending, Treatment decisions pending, Revenue opportunity, and Spend at risk for the currently filtered set — so the page reads as "the operational surface behind the dashboard's numbers," not a disconnected generic table. Filters (source, campaign, branch, doctor, journey type, stage, owner, next-action state, date range) are the same vocabulary the dashboard's drill-down links use, so a dashboard click and a manual filter selection land on the same shape of page.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
