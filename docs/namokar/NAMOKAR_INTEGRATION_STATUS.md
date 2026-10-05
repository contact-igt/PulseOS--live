# Integration status — what is real today

Honest status per provider, **per workspace**: the V1 Demo workspace uses fixtures; the V2 Pilot workspace has **nothing connected** (every provider reads *Not configured*) and no fixture credential is copied into it. **Automated tests never contact a real provider.** The CRM works without any of them: *Add Lead* and *Log call* are the manual fallback.

| Integration | Status (V1 Demo · V2 Pilot) | What works | What is needed to go live |
|---|---|---|---|
| **Runo / IVR calls** | V1 **FIXTURE** · V2 **NOT CONFIGURED** (manual **Log call** is the live fallback) | Call records, missed-call → callback task, duplicate events ignored, recordings/transcripts visible to Owner and Admin only. Manual **Log call** always works. | The hospital's Runo credentials and webhook in *Integrations* (secrets are server-side only). |
| **WhatsApp notifications** | V1 **FIXTURE** · V2 **NOT CONFIGURED** | Confirmation (on Confirm) and 1-hour reminder are planned, never duplicated, and re-planned by a 5-minute safety check if the system restarted at the wrong moment ([how](NAMOKAR_NOTIFICATION_RELIABILITY.md)); recorded as sent-in-fixture; failures show *Blocked* / *Failed*. | WhatsApp Business account, approved templates, access token in *Integrations*. |
| **WhatsApp Inbox / conversations** | **OFF** (not part of the pilot) | — (notifications do not depend on it) | Not part of the pilot. |
| **Website "I am interested"** | V1 **FIXTURE** · V2 **NOT CONFIGURED** — endpoint **READY** (nothing posts to it yet; the seeded token is a fixture) | Protected endpoint creates/updates the patient and journey with source *Website* ([contract](NAMOKAR_WEBSITE_INTAKE.md)). | The website must POST to it with the hospital's intake token. |
| **Meta (Instagram / Facebook) leads** | **NOT CONFIGURED** | Enter such leads by hand with the matching source. | A Meta page connection (hospital-owned). |
| **Google leads** | **NOT CONFIGURED** | Enter by hand with source *Google*. | A Google Ads lead-form connection. |
| **CCS IVR** | **NOT CONFIGURED** | — | The provider's documentation. |

Revenue, payments and ROAS are **off** for Namokar and show no ₹ figures.
