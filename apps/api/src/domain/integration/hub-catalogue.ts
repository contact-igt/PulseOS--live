import type { Capability, ConnectorCapability, ConnectorType, IntegrationCategory, IntegrationFieldSpec, IntegrationKey } from "@pulseos/types";

export interface CatalogueEntry {
  key: IntegrationKey;
  category: IntegrationCategory;
  name: string;
  provider: string;
  purpose: string;
  capability: Capability | null;
  /** The connectors row this entry is backed by (provider key). Null for tools that are not connectors (Webhooks). */
  connectorProvider: string | null;
  connectorType: ConnectorType | null;
  connectorCapabilities: ConnectorCapability[];
  /** Set when nothing may be configured or enabled yet; the card says exactly why. */
  blockedReason: string | null;
  configurationFields: IntegrationFieldSpec[];
  secretFields: IntegrationFieldSpec[];
  mappingNotes: string | null;
  /** Needs this to be set before the entry counts as configured (subset of configurationFields keys). */
  requiredConfig: string[];
  requiredSecrets: string[];
}

// The ONE catalogue the Hub renders. Provider names appear here and in the adapter registry only — never in domain logic.
export const INTEGRATION_CATALOGUE: CatalogueEntry[] = [
  {
    key: "google_ads",
    category: "ADS",
    name: "Google Ads",
    provider: "Google",
    purpose: "Read-only campaign, spend and conversion reporting for Marketing Analytics.",
    capability: "GOOGLE_ADS",
    connectorProvider: "google_ads",
    connectorType: "ADS",
    connectorCapabilities: ["SYNC_CAMPAIGNS", "SYNC_SPEND", "SYNC_PERFORMANCE"],
    blockedReason: null,
    configurationFields: [
      { key: "customerId", label: "Customer ID", help: "The 10-digit Google Ads account, without dashes." },
      { key: "loginCustomerId", label: "Manager account ID (optional)" },
    ],
    secretFields: [
      { key: "developerToken", label: "Developer token" },
      { key: "clientId", label: "OAuth client ID" },
      { key: "clientSecret", label: "OAuth client secret" },
      { key: "refreshToken", label: "Refresh token" },
    ],
    mappingNotes: "Reporting only. PulseOS never creates, edits or pauses campaigns in Google Ads.",
    requiredConfig: ["customerId"],
    requiredSecrets: ["developerToken", "clientId", "clientSecret", "refreshToken"],
  },
  {
    key: "meta_ads",
    category: "ADS",
    name: "Meta Ads",
    provider: "Meta",
    purpose: "Read-only campaign, spend and result reporting for Marketing Analytics.",
    capability: "META_ADS",
    connectorProvider: "meta_ads",
    connectorType: "ADS",
    connectorCapabilities: ["SYNC_CAMPAIGNS", "SYNC_SPEND", "SYNC_PERFORMANCE"],
    blockedReason: null,
    configurationFields: [
      { key: "adAccountId", label: "Ad account ID", help: "As shown in Meta Ads Manager (act_… without the prefix)." },
      { key: "leadActionTypes", label: "Actions counted as Meta leads", help: "Comma-separated action types, e.g. onsite_conversion.lead_grouped. Anything not listed is never called a lead." },
    ],
    secretFields: [{ key: "accessToken", label: "System user access token" }],
    mappingNotes: "Reporting only. Only the action types listed above are counted as leads; other actions stay as 'Other actions'.",
    requiredConfig: ["adAccountId"],
    requiredSecrets: ["accessToken"],
  },
  {
    // Inbound: a hospital website posts enquiries TO PulseOS (never an outbound webhook). Backed by the existing website-intake
    // endpoint; its structured settings (a boolean, a list of origins) and its token have their own typed endpoints, so there
    // are no generic string fields here.
    key: "website_leads",
    category: "ADS",
    name: "Website Leads",
    provider: "PulseOS Website Intake",
    purpose: "Receive enquiries from hospital websites and landing pages directly into PulseOS. Automatically create or update patients, lead journeys, attribution, and follow-up tasks.",
    capability: null,
    connectorProvider: "website_form",
    connectorType: "ACQUISITION",
    connectorCapabilities: ["RECEIVE_FORM"],
    blockedReason: null,
    configurationFields: [],
    secretFields: [],
    mappingNotes: "Your website's own server posts each enquiry to the address shown under API details, with the intake token in the X-PulseOS-Intake-Token header. The token must never be placed in page JavaScript.",
    requiredConfig: [],
    requiredSecrets: [],
  },
  {
    key: "runo",
    category: "CALLING",
    name: "Runo",
    provider: "Runo",
    purpose: "Call events, recordings and dispositions from the hospital's calling lines.",
    capability: "RUNO_CALLING",
    connectorProvider: "runo",
    connectorType: "TELEPHONY",
    connectorCapabilities: ["RECEIVE_CALL_EVENT", "FETCH_RECORDING", "RECEIVE_RECORDING", "RECEIVE_TRANSCRIPT"],
    blockedReason: null,
    configurationFields: [],
    secretFields: [{ key: "webhookSharedSecret", label: "Webhook shared secret" }],
    mappingNotes: "Runo dispositions map to PulseOS next actions in the connector's disposition mappings.",
    requiredConfig: [],
    requiredSecrets: ["webhookSharedSecret"],
  },
  {
    key: "ccs_ivr",
    category: "CALLING",
    name: "CCS IVR (Express IVR)",
    provider: "CCS IVRSMS",
    purpose: "Inbound and outbound IVR call reports, missed calls, and audio recordings from Express IVR (ccs.ivrsms.com).",
    capability: "CCS_IVR",
    connectorProvider: "ccs_ivr",
    connectorType: "TELEPHONY",
    connectorCapabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"],
    blockedReason: null,
    configurationFields: [
      { key: "accountEmail", label: "Account Email", help: "Your registered login email on ccs.ivrsms.com" },
    ],
    secretFields: [
      { key: "apiKey", label: "API Key", help: "API Key from ccs.ivrsms.com/admin/api-key" },
      { key: "secretKey", label: "Secret Key" },
      { key: "integrationKey", label: "Integration Key" },
    ],
    mappingNotes: "Copy the Webhook URL below and paste it into ccs.ivrsms.com > Webhook Configuration, select Call Report, and save.",
    requiredConfig: [],
    requiredSecrets: [],
  },
  {
    key: "whatsapp_meta_cloud",
    category: "MESSAGING",
    name: "WhatsApp Business",
    provider: "Meta WhatsApp Cloud API",
    purpose: "Appointment and surgery reminders, staff follow-up messages and (when enabled) the patient Inbox.",
    capability: "WHATSAPP_NOTIFICATIONS",
    connectorProvider: "whatsapp_meta_cloud",
    connectorType: "MESSAGING",
    connectorCapabilities: ["SEND_MESSAGE", "RECEIVE_MESSAGE", "RECEIVE_STATUS"],
    blockedReason: null,
    configurationFields: [
      { key: "phoneNumberId", label: "Phone number ID" },
      { key: "businessAccountId", label: "WhatsApp Business Account ID" },
    ],
    secretFields: [
      { key: "accessToken", label: "Access token" },
      { key: "appSecret", label: "App secret" },
      { key: "webhookVerifyToken", label: "Webhook verify token" },
    ],
    mappingNotes: "Messages outside the 24-hour window are sent only as approved templates (Settings → Message templates).",
    requiredConfig: ["phoneNumberId"],
    requiredSecrets: ["accessToken", "appSecret", "webhookVerifyToken"],
  },
  {
    key: "whatsnexus",
    category: "MESSAGING",
    name: "WhatsNexus WhatsApp",
    provider: "WhatsNexus",
    purpose: "Send approved WhatsApp templates through your WhatsNexus account. WhatsNexus handles Meta delivery, template approval and wallet billing; PulseOS keeps the scheduling and shows delivery status.",
    capability: "WHATSAPP_NOTIFICATIONS",
    connectorProvider: "whatsnexus",
    connectorType: "MESSAGING",
    connectorCapabilities: ["SEND_MESSAGE", "RECEIVE_STATUS"],
    blockedReason: null,
    configurationFields: [
      { key: "baseUrl", label: "WhatsNexus API base URL", help: "HTTPS address of your WhatsNexus backend, without a path (for example https://api.whatsnexus.example)." },
      { key: "tenantId", label: "WhatsNexus tenant ID", help: "The tenant id WhatsNexus issued for this hospital." },
      { key: "useForSending", label: "Send reminders and follow-ups through", help: "Choose WhatsNexus only after Check Status shows Connected. Exactly one provider is used per message; there is no automatic fallback." },
    ],
    secretFields: [
      { key: "apiKey", label: "Integration API key", help: "Issued by a WhatsNexus super admin for this hospital. Never shown again after saving." },
      { key: "callbackSecret", label: "Callback signing secret", help: "Verifies the delivery-status callbacks WhatsNexus sends to the Callback URL shown under Webhooks." },
      { key: "previousCallbackSecret", label: "Previous callback secret (rotation only)", help: "Optional. Keep the old secret here while WhatsNexus switches over, then enter - (a single dash) to remove it." },
    ],
    mappingNotes: "Set the connection mode to Live in Credentials, run Check Status, then choose WhatsNexus under Configuration. Patient replies are handled in WhatsNexus, not in the PulseOS inbox.",
    requiredConfig: ["baseUrl", "tenantId"],
    requiredSecrets: ["apiKey", "callbackSecret"],
  },
  {
    key: "sms",
    category: "MESSAGING",
    name: "SMS",
    provider: "SMS provider",
    purpose: "Text-message reminders.",
    capability: "SMS_NOTIFICATIONS",
    connectorProvider: null,
    connectorType: null,
    connectorCapabilities: [],
    blockedReason: "SMS provider not selected — provider documentation required",
    configurationFields: [],
    secretFields: [],
    mappingNotes: null,
    requiredConfig: [],
    requiredSecrets: [],
  },
  {
    key: "webhooks",
    category: "ADVANCED",
    name: "Outbound Webhooks",
    provider: "Your systems",
    purpose: "Send selected PulseOS events to your own systems, signed.",
    capability: null,
    connectorProvider: null,
    connectorType: null,
    connectorCapabilities: [],
    blockedReason: null,
    configurationFields: [],
    secretFields: [],
    mappingNotes: "Real events only: lead, call, follow-up, appointment and surgery events. Simple conditions, no scripts.",
    requiredConfig: [],
    requiredSecrets: [],
  },
];

export function catalogueEntry(key: string): CatalogueEntry | null {
  return INTEGRATION_CATALOGUE.find((e) => e.key === key) ?? null;
}
