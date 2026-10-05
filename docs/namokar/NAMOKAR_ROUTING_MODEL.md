# Screens, URLs and the breadcrumb (as built)

## Public
| URL | What |
|---|---|
| `/login/namokar-v1` / `/login/namokar-v2` | Namokar's own sign-in — the **standard tenant-branded login** (`/login/<slug>`, the same page for every hospital; see [tenant-branded-login](../tenant-branded-login.md)). "PulseOS × Namokar", *V1 Pilot*, email / password / Remember me. No hospital choice, no Developer access, no create account. Unknown names (`/login/anything`) are a real 404 with a plain "Workspace not found". |
| `/login` | The internal development sign-in (Developer access lives only here). Not used by Namokar. |

Signing out, or an expired session, returns a Namokar user to their own workspace's page (`/login/namokar-v1` or `/login/namokar-v2`; the old `/login/namokar` redirects to V1) (the session carries the hospital's sign-in slug; the last one is remembered in the browser, and only a plain `[a-z0-9-]` slug is ever followed).

## Signed in
| URL | Roles | Notes |
|---|---|---|
| `/command-centre` | Super Admin, Admin | Tabs `?cc=performance` (default for Namokar), `overview`, `report`. Filters (`range`, `from`, `to`, `branch`, `service`) live in the URL. |
| `/leads` | Front Desk, Coordinator, Admin, Super Admin | `?view=` `today · new_today · uncontacted · follow_up_due · appointments_today · appointment_booked · missed_visit · no_response · converted · lost`, plus `range`, `owner`, `source`, `service`. |
| `/journeys/:id` | non-Doctor roles | **One enquiry.** Above the fold: breadcrumb, patient, phone, service, stage, operational status, **original source**, owner, next action, Log call / Add follow-up / Book appointment, then Journey Progress. |
| `/patients/:id` | all | **One person** with all their journeys. |
| `/appointments`, `/front-desk` | non-Doctor roles (Doctor: appointments) | Visit states and the day's queue. |
| `/doctor-home` | Doctor | Queue, Complete consultation, outcome. |
| `/treatments` | Super Admin, Admin, Coordinator | Treatment records and scheduling. |
| `/my-work` | all staff | Follow-ups, callbacks, Appointment Risk. |

## The breadcrumb

`?from=<list>` is put on every link from a list to a detail page. The **root** is that list; the **Patient** is a link; the **Journey** (the enquiry — "Cataract") is the page.

| You came from | Journey page | Patient page |
|---|---|---|
| Leads | Leads › *Patient* › Cataract | Leads › *Patient* |
| Patients | Patients › *Patient* › Cataract | Patients › *Patient* |
| Treatments / Appointments / My Work / Command Centre | that list › *Patient* › Cataract | that list › *Patient* |
| (direct link) | Journeys › *Patient* › Cataract | Patients › *Patient* |

* **List context is URL state.** Each list page's own URL (filters, view, page) is remembered for the tab; the root crumb links back to exactly that URL (`/leads?view=uncontacted`…). Only a URL that is that list's own path is ever stored or followed — never another path or origin.
* The root is carried from Journey to Patient and back, so *Leads › Patient › Cataract* stays rooted at Leads.
* Patient and Journey are never merged, and a patient is never called a "Customer".
* Integration pages (Settings › Integrations › Runo) use the same `Breadcrumb` component when they get a detail page; today Runo opens in a panel.
