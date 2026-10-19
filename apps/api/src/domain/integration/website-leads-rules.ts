import { randomBytes } from "node:crypto";
import { z } from "zod";

// Website Leads: the Hub's view of PulseOS's own public website-intake endpoint (routes in acquisition/website-form.routes.ts).
// Pure rules only (no database): what a valid form configuration is, how it is stored on the connector, and how an intake
// token is made. Structured values stay structured: `requireService` is a boolean and `allowedOrigins` an array of origins in
// the connector's JSON configuration, which is exactly what the intake route reads.

export const DEFAULT_FORM_ID = "website-contact-v1";
export const DEFAULT_FORM_NAME = "Website Contact Form";
export const MAX_ALLOWED_ORIGINS = 20;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A plain http(s) origin (scheme + host + non-default port) or null. No paths, queries, credentials or wildcards; plain http only for loopback. */
export function normalizeOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return null;
  return url.origin;
}

const origins = z
  .array(z.string().max(300))
  .max(MAX_ALLOWED_ORIGINS)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const item of list) {
      const origin = normalizeOrigin(item);
      if (!origin) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_origin" });
        return z.NEVER;
      }
      if (!out.includes(origin)) out.push(origin);
    }
    return out;
  });

export const websiteFormInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    formId: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,59}$/),
    description: z.string().trim().max(200).nullish(),
    enabled: z.boolean(),
    requireService: z.boolean(),
    /** Always record the source as "Website", whatever the page's UTM tags say. */
    fixedSource: z.boolean(),
    allowedOrigins: origins,
  })
  .strict();
export type WebsiteFormInput = z.infer<typeof websiteFormInputSchema>;

export interface WebsiteFormValues {
  formId: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  requireService: boolean;
  fixedSource: boolean;
  allowedOrigins: string[];
}

/** Typed read of the connector configuration; anything of the wrong type is ignored rather than coerced. */
export function readWebsiteForm(configuration: Record<string, unknown> | null, status: string): WebsiteFormValues {
  const c = configuration ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    formId: str(c.formId) ?? DEFAULT_FORM_ID,
    displayName: str(c.formName) ?? DEFAULT_FORM_NAME,
    description: str(c.description),
    // The admin's own choice when recorded (it can differ from the status: see connectorStatusFor), else what the status says.
    enabled: typeof c.formEnabled === "boolean" ? c.formEnabled : status !== "DISABLED",
    requireService: c.requireService === true,
    fixedSource: c.fixedSource === "website",
    allowedOrigins: Array.isArray(c.allowedOrigins) ? c.allowedOrigins.filter((o): o is string => typeof o === "string") : [],
  };
}

/**
 * The connector configuration after saving a form. Other keys already there (the demo's `formIds`, for example) are kept.
 * `requireToken` closes the intake until a token exists: a connector configured here is never an open door by accident.
 * (Connectors that predate this setting keep their existing behaviour.)
 */
export function applyWebsiteForm(current: Record<string, unknown> | null, input: WebsiteFormInput): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  next.formId = input.formId;
  next.formName = input.displayName;
  if (input.description) next.description = input.description;
  else delete next.description;
  next.requireService = input.requireService;
  if (input.fixedSource) next.fixedSource = "website";
  else delete next.fixedSource;
  next.allowedOrigins = [...input.allowedOrigins];
  next.requireToken = true;
  next.formEnabled = input.enabled;
  return next;
}

/** 256 bits of randomness, URL-safe, prefixed so a leaked value is recognisable. */
export function generateIntakeToken(): string {
  return `wlk_${randomBytes(32).toString("base64url")}`;
}

/**
 * The public address of THIS API, the one a hospital's website must call. Trailing slashes are ignored and a path prefix (an API
 * mounted behind a reverse proxy) is kept. Outside production an unset value falls back to localhost so developers see something;
 * in production an unset value is null, and so is any value that is not a plain http(s) address: a misconfiguration is reported,
 * never turned into a misleading localhost or scheme-less address.
 */
export function resolvePublicApiBase(raw: string | undefined, nodeEnv: string | undefined, port: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return nodeEnv === "production" ? null : `http://localhost:${port || 4310}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The connector status for the website intake. The intake route (in this release AND in older ones) refuses a request only when
 * the status is DISABLED, and an older release also ignores `requireToken`. So that a rollback can never expose an open door, a form
 * with no token is stored as DISABLED whatever the admin chose, and the admin's own choice lives in `formEnabled`. Enabling with a
 * token starts verification over; otherwise what real traffic has proven (CONNECTED, ERROR) is kept.
 */
export function connectorStatusFor(input: { enabled: boolean; hasToken: boolean; current: string }): "DISABLED" | "CONNECTING" | "NOT_CONFIGURED" | "CONNECTED" | "DEGRADED" | "ERROR" {
  if (!input.enabled || !input.hasToken) return "DISABLED";
  if (input.current === "DISABLED" || input.current === "NOT_CONFIGURED") return "CONNECTING";
  return input.current as "CONNECTING" | "CONNECTED" | "DEGRADED" | "ERROR";
}
