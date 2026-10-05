import { META_GRAPH_API_VERSION, verifyMetaChallenge, verifyMetaSignature } from "../../connector/meta-webhook.js";
import type { AcquisitionProviderAdapter, CampaignSyncRecord, ConversionFeedbackEventType, ConversionFeedbackPayload, LeadReference, NormalizedLead } from "../types.js";

// developers.facebook.com/docs/graph-api/webhooks/getting-started/
// webhooks-for-leadgen/: the leadgen webhook notification carries ONLY
// leadgen_id/page_id/form_id/adgroup_id/ad_id/created_time — never the
// submitted name/phone/email. Full lead data requires a separate,
// authenticated GET /{leadgen_id} call with a Page access token — hence the
// two-step LeadReference -> fetchLead contract in acquisition/types.ts.
interface MetaLeadgenChangeValue {
  leadgen_id: string | number;
  page_id?: string | number;
  form_id?: string | number;
  adgroup_id?: string | number;
  ad_id?: string | number;
  created_time?: number;
}

interface MetaLeadgenWebhookBody {
  entry?: { changes?: { field?: string; value?: MetaLeadgenChangeValue }[] }[];
}

interface MetaLeadFieldDatum {
  name: string;
  values: string[];
}

interface MetaLeadDetailResponse {
  id: string;
  form_id?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  created_time?: string;
  field_data?: MetaLeadFieldDatum[];
}

interface MetaCampaignResponse {
  id: string;
  name: string;
  status: string;
  start_time?: string;
  stop_time?: string | null;
}

interface MetaInsightsRow {
  campaign_id: string;
  spend: string;
}

// Campaign dimensions (id/name/status/start_time/stop_time) come from
// GET /act_{id}/campaigns; spend is a separate metric only available from
// the insights edge (GET /act_{id}/insights?level=campaign) — no single
// call returns both, so this is necessarily two requests merged by
// campaign_id.
const META_CAMPAIGN_STATUS_MAP: Record<string, CampaignSyncRecord["status"]> = {
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "ended",
  DELETED: "ended",
};

// Meta's Offline Conversions API is discontinued — every CRM-driven
// conversion, including these, goes through the standard Conversions API
// with action_source: "system_generated". event_name maps to Meta's
// standard-event vocabulary: a new qualified enquiry is "Lead"; a completed
// treatment or recorded revenue carries real monetary value, so it's
// reported as "Purchase" (the standard event Meta expects a value/currency
// on); every other milestone is a funnel step with no direct standard-event
// equivalent, so it's reported as the generic "SubmitApplication" event.
const META_CONVERSION_EVENT_NAME: Record<ConversionFeedbackEventType, string> = {
  QUALIFIED_ENQUIRY: "Lead",
  APPOINTMENT_BOOKED: "Schedule",
  APPOINTMENT_ATTENDED: "SubmitApplication",
  CONSULTATION_COMPLETED: "SubmitApplication",
  TREATMENT_ADVISED: "SubmitApplication",
  TREATMENT_COMPLETED: "Purchase",
  REVENUE_RECORDED: "Purchase",
};

function pickFieldValue(fieldData: MetaLeadFieldDatum[] | undefined, names: string[]): string | null {
  if (!fieldData) return null;
  for (const name of names) {
    const match = fieldData.find((f) => f.name === name);
    if (match?.values?.[0]) return match.values[0];
  }
  return null;
}

// Deterministic, not random — the same leadgen_id always maps to the same
// fixture phone/name, so repeated test runs see stable, reproducible
// fixture data rather than a new "person" every run.
function fixtureDigitsFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return String(hash).padStart(9, "0").slice(-9);
}

export const metaLeadAdsAdapter: AcquisitionProviderAdapter = {
  capabilities: ["RECEIVE_LEAD", "SYNC_CAMPAIGNS", "SYNC_SPEND", "EXPORT_CONVERSION"],

  verifyWebhookChallenge(query, secrets) {
    return verifyMetaChallenge(query, secrets.webhookVerifyToken);
  },

  verifyWebhookSignature(rawBody, signatureHeader, secrets) {
    return verifyMetaSignature(rawBody, signatureHeader, secrets.appSecret);
  },

  parseWebhookLeadReferences(payload): LeadReference[] {
    const body = payload as MetaLeadgenWebhookBody;
    const refs: LeadReference[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "leadgen" || !change.value) continue;
        const v = change.value;
        refs.push({
          externalLeadId: String(v.leadgen_id),
          externalFormId: v.form_id != null ? String(v.form_id) : null,
          externalAdGroupId: v.adgroup_id != null ? String(v.adgroup_id) : null,
          externalAdId: v.ad_id != null ? String(v.ad_id) : null,
          occurredAt: v.created_time ? new Date(v.created_time * 1000) : new Date(),
        });
      }
    }
    return refs;
  },

  async fetchLead(ref, config, secrets): Promise<NormalizedLead> {
    if (config.mode === "fixture") {
      const digits = fixtureDigitsFromId(ref.externalLeadId);
      return {
        externalLeadId: ref.externalLeadId,
        externalFormId: ref.externalFormId,
        externalAccountId: null,
        externalCampaignId: `FIXTURE_CAMPAIGN_${ref.externalFormId ?? "unknown"}`,
        externalAdGroupId: ref.externalAdGroupId,
        externalAdId: ref.externalAdId,
        name: `Fixture Meta Lead ${digits.slice(-4)}`,
        phone: `+919${digits}`,
        email: null,
        source: "meta",
        medium: "paid_social",
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        gclid: null,
        gbraid: null,
        wbraid: null,
        fbclid: `fixture.fbclid.${ref.externalLeadId}`,
        occurredAt: ref.occurredAt,
        metadata: { fixture: true, leadgenId: ref.externalLeadId },
      };
    }

    const accessToken = secrets.pageAccessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Meta Lead Ads connector is missing a pageAccessToken secret");
    }

    const fields = "id,form_id,ad_id,adset_id,campaign_id,created_time,field_data";
    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${ref.externalLeadId}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`Meta lead fetch failed: ${res.status} ${errorBody}`);
    }

    const data = (await res.json()) as MetaLeadDetailResponse;
    return {
      externalLeadId: data.id,
      externalFormId: data.form_id ?? ref.externalFormId,
      externalAccountId: null,
      externalCampaignId: data.campaign_id ?? null,
      externalAdGroupId: data.adset_id ?? ref.externalAdGroupId,
      externalAdId: data.ad_id ?? ref.externalAdId,
      name: pickFieldValue(data.field_data, ["full_name", "first_name"]),
      phone: pickFieldValue(data.field_data, ["phone_number"]),
      email: pickFieldValue(data.field_data, ["email"]),
      source: "meta",
      medium: "paid_social",
      utmCampaign: null,
      utmContent: null,
      utmTerm: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: null,
      occurredAt: data.created_time ? new Date(Number(data.created_time) * 1000) : ref.occurredAt,
      metadata: { raw: data as unknown as Record<string, unknown> },
    };
  },

  async syncCampaigns(config, secrets): Promise<CampaignSyncRecord[]> {
    if (config.mode === "fixture") {
      return [
        { externalCampaignId: "FIXTURE_META_CAMPAIGN_1", externalAccountId: "act_fixture", name: "Fixture Meta – Awareness", source: "meta", spendAmount: 12000, currency: "INR", startDate: new Date("2026-08-01T00:00:00Z"), endDate: null, status: "active" },
        { externalCampaignId: "FIXTURE_META_CAMPAIGN_2", externalAccountId: "act_fixture", name: "Fixture Meta – Retargeting", source: "meta", spendAmount: 8000, currency: "INR", startDate: new Date("2026-08-15T00:00:00Z"), endDate: null, status: "paused" },
      ];
    }

    const adAccountId = config.adAccountId;
    const accessToken = secrets.pageAccessToken;
    if (typeof adAccountId !== "string" || !adAccountId) {
      throw new Error("Meta Lead Ads connector is missing an adAccountId configuration value");
    }
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Meta Lead Ads connector is missing a pageAccessToken secret");
    }

    const campaignsRes = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${adAccountId}/campaigns?fields=id,name,status,start_time,stop_time&access_token=${encodeURIComponent(accessToken)}`);
    if (!campaignsRes.ok) throw new Error(`Meta campaign sync failed: ${campaignsRes.status} ${await campaignsRes.text().catch(() => "")}`);
    const campaignsData = (await campaignsRes.json()) as { data: MetaCampaignResponse[] };

    const insightsRes = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${adAccountId}/insights?level=campaign&fields=campaign_id,spend&date_preset=maximum&access_token=${encodeURIComponent(accessToken)}`);
    if (!insightsRes.ok) throw new Error(`Meta spend sync failed: ${insightsRes.status} ${await insightsRes.text().catch(() => "")}`);
    const insightsData = (await insightsRes.json()) as { data: MetaInsightsRow[] };
    const spendByCampaignId = new Map(insightsData.data.map((row) => [row.campaign_id, Number(row.spend)]));

    return campaignsData.data.map((c) => ({
      externalCampaignId: c.id,
      externalAccountId: adAccountId,
      name: c.name,
      source: "meta" as const,
      spendAmount: Math.round(spendByCampaignId.get(c.id) ?? 0),
      currency: "INR",
      startDate: c.start_time ? new Date(c.start_time) : new Date(),
      endDate: c.stop_time ? new Date(c.stop_time) : null,
      status: META_CAMPAIGN_STATUS_MAP[c.status] ?? "ended",
    }));
  },

  buildConversionPayload(payload: ConversionFeedbackPayload, config): Record<string, unknown> {
    const userData: Record<string, string> = {};
    if (payload.fbclid) {
      // Meta's documented fbc cookie format is fb.<subdomain_index>.<creation_time_ms>.<fbclid>
      // — we don't have the original click's subdomain index, so this uses
      // the conventional "1" (the documented default for a first-party
      // apex-domain cookie) with the event's own occurredAt as the
      // creation time, the best available approximation without having
      // captured the real fbc cookie at click time.
      userData.fbc = `fb.1.${payload.occurredAt.getTime()}.${payload.fbclid}`;
    }

    return {
      data: [{
        event_name: META_CONVERSION_EVENT_NAME[payload.eventType],
        event_time: Math.floor(payload.occurredAt.getTime() / 1000),
        action_source: "system_generated",
        event_id: payload.idempotencyKey,
        user_data: userData,
        custom_data: {
          value: payload.value,
          currency: payload.currency,
        },
      }],
      pixel_id: config.pixelId ?? null,
    };
  },
};
