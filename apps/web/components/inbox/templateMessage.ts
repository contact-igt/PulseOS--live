export interface TemplateHeader {
  kind: "image" | "video" | "document";
  /** An https address for the media, or null when it is not available (it is then shown as a placeholder). */
  url: string | null;
}

export interface TemplateButton {
  text: string;
  value: string | null;
  type: "url" | "phone" | "quick_reply";
}

export interface TemplateParts {
  header: TemplateHeader | null;
  body: string;
  buttons: TemplateButton[];
}

const HEADER = /^\[(VIDEO|IMAGE|DOCUMENT):?\s*([^\]\n]+)?\]\n?/i;
const BUTTON = /\[Button:\s*([^\]]+)\]/gi;
const PHONE = /^\+?[\d\s-]{7,}$/;

const httpsUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};

/**
 * WhatsNexus stores a template message as plain text: "[IMAGE: url]" on the first line for header media, then the body, and
 * "[Button: Label (value)]" or "[Button: Label | value]" for each button. This reads that back into the parts WhatsApp shows.
 * Media and links are only ever https; anything else becomes a placeholder or a plain button.
 */
export function parseTemplateBody(message: string): TemplateParts {
  let rest = message;
  let header: TemplateHeader | null = null;
  const h = HEADER.exec(rest);
  if (h) {
    header = { kind: h[1]!.toLowerCase() as TemplateHeader["kind"], url: httpsUrl(h[2]) };
    rest = rest.slice(h[0].length);
  }

  const buttons: TemplateButton[] = [];
  for (const m of rest.matchAll(BUTTON)) {
    const full = m[1]!.trim();
    let text = full;
    let raw: string | undefined;
    if (full.includes("|")) {
      const [label, value] = full.split("|").map((p) => p.trim());
      text = label ?? full;
      raw = value;
    } else {
      const parens = /^(.+?)\s*\((.+)\)\s*$/.exec(full);
      if (parens) {
        text = parens[1]!.trim();
        raw = parens[2]!.trim();
      }
    }
    const link = httpsUrl(raw);
    if (link) buttons.push({ text, value: link, type: "url" });
    else if (raw && PHONE.test(raw)) buttons.push({ text, value: raw, type: "phone" });
    else buttons.push({ text, value: null, type: "quick_reply" });
  }

  const body = rest.replace(/\n?\[Button:\s*[^\]]+\]/gi, "").replace(/\{\{\d+\}\}/g, "").trim();
  return { header, body, buttons };
}
