import { timingSafeEqual } from "node:crypto";
import type { AcquisitionProviderAdapter, CampaignSyncRecord, ConversionFeedbackPayload, NormalizedLead } from "../types.js";

// developers.google.com/google-ads/api/rest: the REST interface exposes
// GoogleAdsService.SearchStream as
// POST /v25/customers/{customerId}/googleAds:searchStream with a GAQL query
// body — auth is a normal OAuth2 Bearer token plus a developer-token header
// (not the google_key used by the lead webhook, a completely separate
// credential). Response is a JSON array of stream chunks, each with its own
// `results` array, flattened here since a foundation-level campaign sync
// has no reason to process them incrementally.
const GOOGLE_ADS_API_VERSION = "v25";

const GOOGLE_CAMPAIGN_STATUS_MAP: Record<string, CampaignSyncRecord["status"]> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "ended",
};

interface GoogleAdsCampaignResult {
  campaign?: { id?: string; name?: string; status?: string; startDate?: string; endDate?: string | null };
  metrics?: { costMicros?: string };
}

interface GoogleAdsSearchStreamChunk {
  results?: GoogleAdsCampaignResult[];
}

// developers.google.com/google-ads/webhook/docs/implementation: unlike
// Meta, Google delivers the FULL submission in a single POST — no separate
// fetch step exists. Auth is a plaintext google_key field inside the JSON
// body (not a header/HMAC), verified against the secret configured in the
// Google Ads UI. Dedup key is lead_id. The docs explicitly warn against
// assuming a fixed field set — "gracefully ignore fields you don't
// recognize" — which is also why field mapping here is a strict whitelist
// (column_id -> known name) rather than passing arbitrary submitted fields
// through: an unrecognized column must never reach Patient/Journey data.
interface GoogleLeadFormColumn {
  column_id?: string;
  column_name?: string;
  string_value?: string;
}

interface GoogleLeadFormWebhookBody {
  lead_id?: string;
  api_version?: string;
  form_id?: string | number;
  campaign_id?: string | number;
  adgroup_id?: string | number;
  gcl_id?: string;
  google_key?: string;
  is_test?: boolean;
  lead_submit_time?: string;
  user_column_data?: GoogleLeadFormColumn[];
}

function pickColumn(columns: GoogleLeadFormColumn[] | undefined, columnId: string): string | null {
  return columns?.find((c) => c.column_id === columnId)?.string_value ?? null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const googleAdsLeadFormsAdapter: AcquisitionProviderAdapter = {
  capabilities: ["RECEIVE_LEAD", "SYNC_CAMPAIGNS", "SYNC_SPEND", "EXPORT_CONVERSION"],

  verifyWebhookKey(payload, secrets) {
    const body = payload as GoogleLeadFormWebhookBody;
    const configuredKey = secrets.googleKey;
    if (typeof configuredKey !== "string" || !configuredKey) return false;
    if (typeof body.google_key !== "string" || !body.google_key) return false;
    return timingSafeStringEqual(body.google_key, configuredKey);
  },

  parseWebhookLead(payload): NormalizedLead[] {
    const body = payload as GoogleLeadFormWebhookBody;
    if (!body.lead_id) return [];

    const columns = body.user_column_data;
    return [{
      externalLeadId: body.lead_id,
      externalFormId: body.form_id != null ? String(body.form_id) : null,
      externalAccountId: null,
      externalCampaignId: body.campaign_id != null ? String(body.campaign_id) : null,
      externalAdGroupId: body.adgroup_id != null ? String(body.adgroup_id) : null,
      externalAdId: null,
      name: pickColumn(columns, "FULL_NAME"),
      phone: pickColumn(columns, "PHONE_NUMBER"),
      email: pickColumn(columns, "EMAIL"),
      source: "google",
      medium: "cpc",
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      gclid: body.gcl_id ?? null,
      gbraid: null,
      wbraid: null,
      fbclid: null,
      occurredAt: body.lead_submit_time ? new Date(body.lead_submit_time) : new Date(),
      metadata: { isTestLead: body.is_test === true },
    }];
  },

  async syncCampaigns(config, secrets): Promise<CampaignSyncRecord[]> {
    if (config.mode === "fixture") {
      return [
        { externalCampaignId: "FIXTURE_GOOGLE_CAMPAIGN_1", externalAccountId: "fixture-customer-id", name: "Fixture Google – Search", source: "google", spendAmount: 18000, currency: "INR", startDate: new Date("2026-08-01T00:00:00Z"), endDate: null, status: "active" },
        { externalCampaignId: "FIXTURE_GOOGLE_CAMPAIGN_2", externalAccountId: "fixture-customer-id", name: "Fixture Google – Display", source: "google", spendAmount: 6000, currency: "INR", startDate: new Date("2026-08-10T00:00:00Z"), endDate: null, status: "paused" },
      ];
    }

    const customerId = config.customerId;
    const accessToken = secrets.accessToken;
    const developerToken = secrets.developerToken;
    if (typeof customerId !== "string" || !customerId) {
      throw new Error("Google Ads Lead Forms connector is missing a customerId configuration value");
    }
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Google Ads Lead Forms connector is missing an accessToken secret");
    }
    if (typeof developerToken !== "string" || !developerToken) {
      throw new Error("Google Ads Lead Forms connector is missing a developerToken secret");
    }

    const query = "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date, campaign.end_date, metrics.cost_micros FROM campaign";
    const res = await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "developer-token": developerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`Google Ads campaign sync failed: ${res.status} ${errorBody}`);
    }

    const chunks = (await res.json()) as GoogleAdsSearchStreamChunk[];
    const results = chunks.flatMap((c) => c.results ?? []).filter((r) => r.campaign?.id);

    return results.map((r) => ({
      externalCampaignId: r.campaign!.id!,
      externalAccountId: customerId,
      name: r.campaign!.name ?? "Unnamed Campaign",
      source: "google" as const,
      spendAmount: Math.round(Number(r.metrics?.costMicros ?? 0) / 1_000_000),
      currency: "INR",
      startDate: r.campaign!.startDate ? new Date(r.campaign!.startDate) : new Date(),
      endDate: r.campaign!.endDate ? new Date(r.campaign!.endDate) : null,
      status: GOOGLE_CAMPAIGN_STATUS_MAP[r.campaign!.status ?? ""] ?? "ended",
    }));
  },

  // developers.google.com/data-manager/api: the Data Manager API is
  // Google's current direction for offline/CRM conversion uploads — the
  // older Google Ads API ConversionUploadService.UploadClickConversions is
  // being cut off for new adopters, so a brand-new integration like
  // PulseOS's has no reason to build against it. This builds an
  // IngestEventsRequest body — a pure function, calling nothing.
  buildConversionPayload(payload: ConversionFeedbackPayload, config): Record<string, unknown> {
    const adIdentifiers: Record<string, string> = {};
    if (payload.gclid) adIdentifiers.gclid = payload.gclid;
    else if (payload.gbraid) adIdentifiers.gbraid = payload.gbraid;
    else if (payload.wbraid) adIdentifiers.wbraid = payload.wbraid;

    return {
      destinations: [{
        operatingAccount: { productAccountId: config.customerId ?? null },
        productDestinationId: config.conversionActionId ?? null,
      }],
      events: [{
        transactionId: payload.idempotencyKey,
        eventTimestamp: payload.occurredAt.toISOString(),
        currency: payload.currency,
        conversionValue: payload.value,
        adIdentifiers,
        // Only ever built downstream of conversion-feedback.service.ts,
        // which refuses to create a payload for a patient without
        // marketingConsent in the first place — so by construction this is
        // only ever called for a consent-eligible patient.
        consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" },
      }],
    };
  },
};
