import type { MessagingProviderAdapter, TelephonyProviderAdapter } from "./types.js";
import { whatsAppMetaCloudAdapter } from "./adapters/whatsapp-meta-cloud.js";
import { runoTelephonyAdapter } from "./adapters/runo.js";
import { ccsTelephonyAdapter } from "./adapters/ccs.js";
import type { AcquisitionProviderAdapter } from "../acquisition/types.js";
import { metaLeadAdsAdapter } from "../acquisition/adapters/meta-lead-ads.js";
import { googleAdsLeadFormsAdapter } from "../acquisition/adapters/google-ads-lead-forms.js";
import { googleBusinessProfileAdapter } from "../acquisition/adapters/google-business-profile.js";

// The ONLY place a provider name is ever matched against a string. Domain
// services (Conversation, Task, Timeline) never branch on "whatsapp" or
// "runo" — they call through MessagingProviderAdapter/TelephonyProviderAdapter.
export const MESSAGING_ADAPTERS: Record<string, MessagingProviderAdapter> = {
  whatsapp_meta_cloud: whatsAppMetaCloudAdapter,
};

export const TELEPHONY_ADAPTERS: Record<string, TelephonyProviderAdapter> = {
  runo: runoTelephonyAdapter,
  ccs_ivr: ccsTelephonyAdapter,
};

// website_form has no adapter entry here — it's PulseOS's own public form
// endpoint (website-form.routes.ts), not a third-party provider with a
// provider-specific webhook shape to normalize.
export const ACQUISITION_ADAPTERS: Record<string, AcquisitionProviderAdapter> = {
  meta_lead_ads: metaLeadAdsAdapter,
  google_ads_lead_forms: googleAdsLeadFormsAdapter,
  google_business_profile: googleBusinessProfileAdapter,
};

export function getMessagingAdapter(provider: string): MessagingProviderAdapter | null {
  return MESSAGING_ADAPTERS[provider] ?? null;
}

export function getTelephonyAdapter(provider: string): TelephonyProviderAdapter | null {
  return TELEPHONY_ADAPTERS[provider] ?? null;
}

export function getAcquisitionAdapter(provider: string): AcquisitionProviderAdapter | null {
  return ACQUISITION_ADAPTERS[provider] ?? null;
}
