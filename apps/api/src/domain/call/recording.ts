import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

// Authenticated recording playback/download. The browser never receives the provider's URL: it calls PulseOS,
// PulseOS authorizes tenant + permission, then streams the bytes from the provider (HTTP Range forwarded so audio
// can seek; nothing is buffered in memory). The one deliberate limit: PulseOS cannot sign URLs for a provider that
// does not offer it, so the provider URL must be reachable from the server.

export const FIXTURE_SCHEME = "pulseos-fixture://";
export const FIXTURE_RECORDING_REF = `${FIXTURE_SCHEME}silence.wav`;

const SAMPLE_RATE = 8000;
const FIXTURE_SECONDS = 6;

/** A short, silent 8-bit mono WAV: a playable stand-in for demo/FIXTURE recordings. Honest: it contains no speech. */
export function fixtureRecordingBytes(): Buffer {
  const dataLen = SAMPLE_RATE * FIXTURE_SECONDS;
  const buf = Buffer.alloc(44 + dataLen, 128); // 128 = silence for unsigned 8-bit PCM
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

/** SSRF guard for a URL a provider webhook supplied. Production: https only, no private/loopback hosts. */
export function isSafeProviderUrl(raw: string, env: Record<string, string | undefined> = process.env): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const production = env.NODE_ENV === "production";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !production)) return false;
  if (production) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || PRIVATE_V4.test(host) || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return false;
  }
  return true;
}

function sendFixture(request: FastifyRequest, reply: FastifyReply, opts: { download: boolean; filename: string }) {
  const bytes = fixtureRecordingBytes();
  reply.header("content-type", "audio/wav").header("x-content-type-options", "nosniff").header("accept-ranges", "bytes").header("cache-control", "private, no-store");
  if (opts.download) reply.header("content-disposition", `attachment; filename="${opts.filename}.wav"`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : bytes.length - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : bytes.length - 1;
    end = Math.min(end, bytes.length - 1);
    start = Math.max(0, start);
    if (start > end || start >= bytes.length) return reply.status(416).header("content-range", `bytes */${bytes.length}`).send();
    return reply.status(206).header("content-range", `bytes ${start}-${end}/${bytes.length}`).header("content-length", end - start + 1).send(bytes.subarray(start, end + 1));
  }
  return reply.status(200).header("content-length", bytes.length).send(bytes);
}

/**
 * In production, a hostname must also RESOLVE to public addresses (a public-looking name that points at an internal
 * host is refused). Not a full defence against DNS rebinding between this check and the fetch — see the report.
 */
async function resolvesToPublicHosts(rawUrl: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.NODE_ENV !== "production") return true;
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isSafeProviderUrl(`https://${a.address.includes(":") ? `[${a.address}]` : a.address}/`, env));
  } catch {
    return false;
  }
}

const SINGLE_RANGE = /^bytes=\d*-\d*$/;
const MAX_REDIRECTS = 3;
const HEADERS_TIMEOUT_MS = 15_000;

/**
 * Stream a call recording to the caller. Forwards Range; sets Content-Disposition for downloads. Returns the reply
 * (so the route can `return` it). A provider that cannot be reached is a quiet 502 — never the raw URL in the body.
 */
export async function streamRecording(request: FastifyRequest, reply: FastifyReply, recordingRef: string, opts: { download: boolean; filename: string }): Promise<FastifyReply> {
  if (recordingRef.startsWith(FIXTURE_SCHEME)) return sendFixture(request, reply, opts);

  const unavailable = () => reply.status(502).send({ error: "recording_unavailable" });
  const controller = new AbortController();
  request.raw.on("close", () => controller.abort());

  let target = recordingRef;
  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeProviderUrl(target) || !(await resolvesToPublicHosts(target))) return unavailable();
    const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
    try {
      upstream = await fetch(target, { headers: SINGLE_RANGE.test(String(request.headers.range ?? "")) ? { range: String(request.headers.range) } : {}, redirect: "manual", signal: controller.signal });
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      target = new URL(location, target).toString();
      continue;
    }
    break;
  }
  if (!upstream || (upstream.status !== 200 && upstream.status !== 206) || !upstream.body) return unavailable();

  // Only audio is served as audio; anything else a provider returns is forced to an opaque download, never rendered by the browser.
  const upstreamType = upstream.headers.get("content-type") ?? "";
  const contentType = /^audio\/[\w.+-]+/i.test(upstreamType) ? upstreamType : "application/octet-stream";
  reply.status(upstream.status).header("content-type", contentType).header("x-content-type-options", "nosniff").header("accept-ranges", upstream.headers.get("accept-ranges") ?? "bytes").header("cache-control", "private, no-store");
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (opts.download || contentType === "application/octet-stream") reply.header("content-disposition", `attachment; filename="${opts.filename}.${/wav/i.test(contentType) ? "wav" : "mp3"}"`);
  return reply.send(Readable.fromWeb(upstream.body as never));
}
