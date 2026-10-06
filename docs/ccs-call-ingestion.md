# CCS Express IVR: calls into the patient journey

How a CCS call report becomes a Patient, a Journey, a Call, a Timeline line and (when missed) a callback, and how to verify it
with a real call.

## Status of the field names: read this first

PulseOS has **never received a real CCS webhook**. The only CCS events ever stored were a hand-made test (`ccs_test_101`) and the
"Send test call event" button. The field names below are **candidates** (the CCS dashboard's call-report columns and common IVR
call-record vocabulary). Matching ignores case and separators (`Caller Number`, `caller_number`, `callerNumber` are one name).
Every field PulseOS does not recognise is kept (credentials removed, values capped to 300 characters) in the call's metadata
under `unmapped`, so nothing from the first real payload is lost.

## Mapping (CCS candidate field -> canonical -> where it lands)

| Canonical | Candidate CCS names (first match wins) | Lands in |
|---|---|---|
| provider call id (idempotency) | `call_id`, `callid`, `uniqueid`, `uuid`, `id`, `session_id`, `call_uuid`, `sid`, `cdr_id` | `calls.external_call_id`; event `ccs:event:<id>`. No id: a stable `ccs:derived:<hash>` of caller, line, start time, duration, agent |
| caller | `caller_number`, `caller_no`, `caller`, `caller_id`, `customer_number`, `phone_number`, `phone`, `mobile`, `from`, `cli`, `calling_number` | `calls.phone` (as sent); Patient by E.164 |
| IVR / deskphone line | `called_number`, `called_no`, `called`, `dialed_number`, `dnis`, `ivr_number`, `deskphone`, `did`, `virtual_number` | resolves a **communication endpoint** (the line); `calls.metadata.calledLine` |
| agent / member | `agent_name`, `agent_number`, `agent`, `member_name`, `member`, `executive`, `operator`, `extension`, `answered_by` | `calls.agent_name`; `calls.handled_by_user_id` when mapped |
| call group | `call_group`, `group`, `group_name`, `queue` | `calls.metadata.callGroup` |
| started / answered / ended | `start_time`, `call_time`, `datetime`, `created_at`, `call_date` / `answer_time` / `end_time` | `calls.started_at`, `ended_at`; answered in metadata |
| duration | `duration`, `call_duration`, `talk_duration`, `billsec` (seconds, `HH:MM:SS`, `MM:SS`, `1m 26s`) | `calls.duration_seconds` |
| status | `status`, `call_status`, `dial_status`, `call_state`, `disposition` | `calls.status`; CCS's own wording in `metadata.providerDisposition` |
| direction | `direction`, `call_type`, `type` (contains "out" = outbound, else inbound) | `calls.direction` |
| telecom circle | `circle`, `telecom_circle` | `calls.metadata.circle` **only** |
| IVR key pressed | `ivr_key`, `dtmf`, `key_pressed`, `ivr_selection`, `menu_option`, `digits` | `calls.metadata.ivrSelection` (see limitations) |
| recording | `recording_url`, `recording`, `record_url`, `audio_url`, `file_url`, `call_recording` | `calls.recording_url` (never returned to the browser) |
| caller name | `customer_name`, `caller_name`, `name` | Patient name only if the Patient has none |

Rules that are decisions, not guesses:

- **Inbound "No Answer" = Missed** (someone is waiting for a callback). Outbound "No Answer" stays `no_answer` and creates no missed-call work.
- **Zoneless CCS times are read as IST (+05:30)**; an explicit offset or `Z` is honoured; `DD-MM-YYYY` is read day-first.
- **Answered is not attended.** An answered call never books, attends or converts anything.
- **Telecom circle is never the patient's location.** It is shown as "approximate" provider metadata.
- **Phone numbers:** `9810157258`, `+91 98101 57258`, `09810157258`, `91-98101-57258` all become `+919810157258`. A number with `+` or `00` keeps its own country. A bare number with no prefix is read in the hospital's default region (India), so a bare US number such as `14155552671` is not recognisable as international.

## Attribution (Super Admin: Integrations -> CCS IVR -> Lines & team)

Each IVR number is a communication endpoint with an optional **Source**, **Source detail**, **Department** and **Branch**. A brand-new
enquiry on that line takes them. Sources are whatever the hospital has defined, so offline sources (health camp, newspaper,
hoarding, doctor/partner referral, international partner) work exactly like digital ones: define the source, map the line to it.
A line with no mapping, an unknown line, or a report with no line counts as **Phone** with detail "CCS Express IVR". A reported
line that matches nothing is never guessed.

A repeat caller reuses the Patient and the active Journey (a closed Journey is not reopened). Mapping a CCS agent to a team member
records who **handled** the call; it never changes who **owns** the Journey.

## Capturing the first real payload

1. Deploy, and make sure CCS sends a saved key (see `deployment-railway.md`).
2. Make one real call to an IVR line (answered) and one that goes unanswered.
3. As Super Admin: `GET /integrations/hub/ccs_ivr/payload-shapes` returns the field names CCS actually sent, how often, whether PulseOS
   recognises each, and the distinct values of status-like fields. Names and category values only: no phone numbers, no secrets.
4. Anything `recognised: false` that matters (called line, group, circle, key pressed, answer time) is added to the alias table in
   `apps/api/src/domain/connector/adapters/ccs-normalizer.ts`, with a test using that real shape.

## Acceptance checklist for a real call

Caller (masked), call time -> in PulseOS: Last valid call report updates; one Call (status, duration, handled-by when mapped);
Patient found or created (name blank, never invented); Journey found or created with the line's source; Timeline line
("Incoming IVR call - Answered by ..." / "Missed IVR call"); for a missed call, one callback task in My Work (owner) or the
Unassigned queue; no Appointment or Visit; replaying the same call changes nothing.

## Known limits

- IVR key -> intent (press 1 = appointments) is **not built**: the key is captured but nothing maps it, because the payload has not
  shown that CCS sends it.
- The webhook is the only CCS ingress; there is no outbound CCS API, so there is no "test connection".
- A call with neither a CCS id nor a start time derives its identity from the minute it arrives: two different calls from one
  caller to one line within the same minute would merge.

## What PulseOS expects from CCS (the receiving side: proven by tests)

| | |
|---|---|
| URL | `https://<api-host>/webhooks/ccs/<connector-id>`, exactly as shown in Integrations -> CCS IVR -> Webhooks (complete once the API is reached on its public host; set `PUBLIC_API_BASE_URL` so the scheme is right behind a proxy) |
| Method | `POST` (JSON or `application/x-www-form-urlencoded`) or `GET` with the fields in the query string |
| Authentication | One saved key, presented as a header (`x-api-key` / `secret-key` / `integration-key` and their variants) **or** as a query/body parameter (`api_key` / `secret_key` / `integration_key`). Without one, the answer is `401` and nothing is stored |
| Responses | `200` accepted (a retry is also `200`), `401` unauthorised, `422` authenticated but no readable caller, `400` not JSON, `503` credential storage not configured |

## What CCS actually does (observed, 2026-10-06)

The first real delivery arrived as `POST`, `application/json`, user agent `axios/1.7.7`, about 20 seconds after an unanswered call ended,
and carried **no credential**: no header, no query parameter and no credential-named body field. CCS's Webhook Configuration offers only a
URL, a method and event tick-boxes. So the only place a secret can travel is the **URL**.

Do not put the CCS API key in the URL: it grants CCS account access and would sit in CCS's configuration and Railway's logs. Instead,
Integrations -> CCS IVR -> Webhooks -> **Create secure webhook address** mints a dedicated token that PulseOS generates, stores encrypted, and
puts in the URL **path** (`/webhooks/ccs/<connector-id>/<token>`). It survives however CCS builds the request, unlocks only this one inbox,
is shown **once**, and can be replaced (the old one then stops working). It is redacted from PulseOS's request logs. The `?api_key=` query
form still works for any sender that can carry it.

## What is NOT known: the CCS side

**PROVIDER WEBHOOK CONFIGURATION REQUIRES EXPRESS IVR SUPPORT/DOCUMENTATION.** `ccs.ivrsms.com` is a login page with no public
documentation, and nothing in this repository proves the dashboard's webhook settings. The only repository text on it is a note from
the original integration ("paste it into ccs.ivrsms.com > Webhook Configuration, select Call Report"), written without CCS
documentation. Before the real-call test, read the account's **API & Integration** page (or ask CCS support) and establish:

1. Is there a setting that **pushes** a call report to a URL when a call ends (a webhook / "callback URL")? Where is it, and is it per IVR line or per account?
2. Which **HTTP method** does CCS use (POST or GET), and which body format (JSON, form-encoded, query string)?
3. **How can authentication be sent?** A custom header, an extra query parameter on the URL, or neither. This decides whether CCS can reach PulseOS at all, because PulseOS refuses unauthenticated calls and will not be made public again to suit a provider.
4. Which **event** triggers it (call end, answered, missed), and are **missed / no-answer calls** pushed too?
5. Does it send the **called IVR line**, **agent/member**, **call group**, **circle**, **IVR key** and a **recording** reference, and under what field names? (A real captured request answers this; see "Capturing the first real payload".)

If CCS can send a custom header or extra URL parameter, use one of the forms in the table above. If it can do neither, ingestion needs
a different secure mechanism that CCS actually supports (for example a longer unguessable path token, or provider IP allow-listing if CCS
publishes fixed addresses); that is a decision to make with evidence, not by weakening the check.
