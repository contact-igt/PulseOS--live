/** Pasting a code brings whitespace, line breaks and quotes with it. None of them are part of the code. */
export const normalizePairingCode = (raw: string): string => raw.replace(/["'“”‘’\s]/g, "");

/** The shape WhatsNexus issues (wnpair_<tenant>.<secret>). A quick local check so an API key pasted by mistake is caught at once. */
export const looksLikePairingCode = (code: string): boolean => /^wnpair_[A-Za-z0-9_-]{1,140}\.[A-Za-z0-9_-]{30,64}$/.test(code);

const PROBLEMS: Record<string, string> = {
  pair_invalid_code: "That code is not valid or has already been used. Ask for a new one in WhatsNexus.",
  pair_code_expired: "That code has expired. Codes last 15 minutes; ask for a new one in WhatsNexus.",
  pair_binding_mismatch: "That code was issued for a different hospital in PulseOS. Ask for a code made for this hospital.",
  pair_tenant_inactive: "WhatsNexus says this hospital's tenant is not active there. Activate it in WhatsNexus first.",
  pair_integration_off: "The PulseOS integration is not switched on in WhatsNexus yet (platform setting).",
  pair_callback_rejected: "WhatsNexus refused PulseOS's callback address. It must be a public https address; set PUBLIC_API_BASE_URL on this server to one (for example an https tunnel in development).",
  pair_rate_limited: "Too many attempts. Wait a few minutes and try again.",
  pair_unreachable: "PulseOS could not reach WhatsNexus at that address. Check the base URL.",
  pair_unexpected_response: "WhatsNexus answered with something unexpected. Check the base URL points at the WhatsNexus backend.",
  public_url_not_configured: "This PulseOS server does not know its own public address. Set PUBLIC_API_BASE_URL, then try again.",
  https_required: "The WhatsNexus base URL must start with https://.",
  private_address: "The WhatsNexus base URL must be a public address, not a local or private one.",
  invalid_url: "The WhatsNexus base URL is not a valid address (use only the scheme and host, with no path).",
  credentials_in_url: "Remove the user name and password from the base URL.",
  forbidden: "Only a Super Admin can connect WhatsNexus.",
};

/** What went wrong, in words a hospital administrator can act on. The raw reason code is never shown. */
export const pairingProblem = (reason: string | undefined): string => (reason && PROBLEMS[reason]) || "Could not connect WhatsNexus. Check the base URL and the code, then try again.";
