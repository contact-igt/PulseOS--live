import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
function resolveApiOrigin(raw: string | undefined): string {
  if (!raw) return "http://localhost:4310";
  const trimmed = raw.trim();
  const withProto = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return "http://localhost:4310";
  }
}

// Where the browser reaches the PulseOS API (fetch + call-recording <audio>). Same default as the api-client.
const apiOrigin = resolveApiOrigin(process.env.NEXT_PUBLIC_API_URL);

/**
 * Baseline CSP. Next.js emits inline bootstrap scripts, so script-src keeps 'unsafe-inline' (a per-request nonce via
 * a proxy is the next step); everything else is closed: no framing, no plugins, forms and <base> only to self, and
 * network access only to this app and the PulseOS API. Dev adds 'unsafe-eval' + websockets for React Refresh/HMR.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin}${isDev ? " ws://localhost:* http://localhost:*" : ""}`,
  `media-src 'self' blob: ${apiOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // HTTPS-only deployments; harmless to omit on plain-http localhost.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  transpilePackages: ["@pulseos/ui", "@pulseos/design-tokens", "@pulseos/types", "@pulseos/api-client"],
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  // The old Namokar sign-in address keeps working: it is a safe alias of the V1 Demo page (V2 Pilot lives at /login/namokar-v2).
  async redirects() {
    return [{ source: "/login/namokar", destination: "/login/namokar-v1", permanent: false }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
