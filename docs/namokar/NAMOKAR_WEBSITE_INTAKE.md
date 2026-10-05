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
`requireService`, `fixedSource: "website"`, `allowedOrigins: [...]`. The token is stored encrypted as the connector secret `intakeToken`. The seeded token is a **fixture** and must be replaced before any real website posts. Replace it with `PATCH /connectors/{connectorId}` and `{ "secrets": { "intakeToken": "<a long random value>" } }` (Super Admin only). The Integrations screen has **no field for this token yet** — a known gap; until then use the API.

Not configured live: nothing posts to this endpoint until Namokar's website is changed to do so.
