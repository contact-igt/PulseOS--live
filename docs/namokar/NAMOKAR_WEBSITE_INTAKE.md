# Website "I am interested" form — contract

`POST {API}/forms/website/{connectorId}` — the connector id (a UUID) is shown in **Integrations → Website Contact Form**. The hospital is **always** the connector's; nothing in the body can name or change it.

## Never put the token in the page
The browser form must post to **Namokar's own web server** (or a serverless function), which adds the token and calls PulseOS. A token in page JavaScript is public.

```
POST /forms/website/{connectorId}
Content-Type: application/json
X-PulseOS-Intake-Token: <the hospital's intake token>
Origin: (optional; if sent it must be https://www.namokar-eye.example)

{
  "submissionId": "web-2026-10-03-7f3a",   // unique per submission; a retry is accepted once
  "formId": "namokar-interested",
  "name": "Asha Kulkarni",                   // required, ≤ 120
  "phone": "+91 98 2000 0000",              // required, a valid phone, ≤ 20
  "service": "Cataract",                     // required for Namokar, ≤ 120
  "message": "Please call after 5 pm",       // optional, ≤ 1000
  "email": "asha@example.com",               // optional
  "pageUrl": "https://www.namokar-eye.example/cataract"   // optional, ≤ 500
}
→ 200 {"ok":true,"duplicate":false,"deduped":false}
```

| Status | Meaning |
|---|---|
| 200 | Accepted. `duplicate:true` = this `submissionId` was already received. `deduped:true` = the phone belongs to a known patient with an open journey; the message was added to it. |
| 401 | Missing or wrong token (same answer for both). |
| 403 | Connector disabled, or a browser `Origin` that is not allowed. |
| 422 | A field is missing, too long, or the phone is not a valid number. |
| 429 | Too many requests from this address (`Retry-After` seconds). Default 20 per minute per address, tunable with `FORM_INTAKE_MAX_PER_MINUTE`. |

## What PulseOS does
Finds the patient by normalized phone (or creates one), uses the patient's open journey or opens a new one for the service, records **Source = Website** (whatever UTM tags say), writes a Timeline line "Website enquiry received" with the message, and creates a callback task for the team. Internal ids are **not** returned.

## Configuration (non-secret, on the connector)
`requireService`, `fixedSource: "website"`, `allowedOrigins: [...]`. Settings are now managed in **Integrations → Ads & Attribution → Website Leads → Website form** (typed settings; the form ID is a label, not a security boundary). A Super Admin creates or replaces the token there: it is shown once, stored encrypted as the connector secret `intakeToken`, and replacing it stops the old one at once. A connector configured through that screen has `requireToken: true`, so the intake refuses every request until a token exists; connectors created before it (no flag) behave as before. Processing failures are recorded as the category `processing_failed` only, never the error text.

### Refused requests in Activity
Refusals for a real connector appear under Integrations → Website Leads → Activity as **submission rejected (auth | origin | validation | disabled)** with fixed wording only: never the visitor's details, headers, the token or the body. At most one entry per kind per minute is stored however many requests are refused, an unknown connector id writes nothing, and these never change the connector's health. Rate-limited (429) requests are answered before the connector is looked up and are not recorded.

### Behind a proxy
Set `TRUST_PROXY` to the number of proxies in front of the API; unset means trust nobody, so a forged `X-Forwarded-For` cannot change a client's rate-limit identity. Set `PUBLIC_API_BASE_URL` to the API's public https address: in production without it the Hub shows no intake address (not a localhost one).

### Failures and retries
A submission is stored all-or-nothing: if processing fails, nothing is kept, the event is recorded as `processing_failed`, and a retry with the same `submissionId` creates the complete set once.

Not configured live: nothing posts to this endpoint until Namokar's website is changed to do so.
