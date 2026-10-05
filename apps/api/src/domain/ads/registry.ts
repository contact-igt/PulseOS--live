import type { AdsProvider } from "@pulseos/types";
import type { AdsReportingProvider } from "./types.js";
import { googleAdsProvider } from "./google-ads.js";
import { metaAdsProvider } from "./meta-ads.js";

// The only place an ads provider name maps to an implementation (domain logic calls AdsReportingProvider).
export const ADS_PROVIDERS_REGISTRY: Record<AdsProvider, AdsReportingProvider> = { google_ads: googleAdsProvider, meta_ads: metaAdsProvider };
export const getAdsProvider = (p: string): AdsReportingProvider | null => (ADS_PROVIDERS_REGISTRY as Record<string, AdsReportingProvider>)[p] ?? null;
