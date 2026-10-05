/** Strip anything credential-shaped from provider text before it is shown to a person. */
export function redactLogText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:access[_-]?token|app[_-]?secret|client[_-]?secret|refresh[_-]?token|developer[_-]?token|verify[_-]?token|api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[redacted]")
    .replace(/\b(Basic\s+)[A-Za-z0-9+/=]{8,}/g, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]")
    // A URL's query string and fragment can carry keys: keep the address, drop what follows.
    .replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/g, "$1?[redacted]")
    .replace(/\b(EAA[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]{20,}|whsec_[a-f0-9]{16,}|[A-Fa-f0-9]{32,})\b/g, "[redacted]")
    .slice(0, 300);
}
