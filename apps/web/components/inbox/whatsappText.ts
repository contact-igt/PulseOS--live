export type TextNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold" | "italic" | "strike"; children: TextNode[] };

const MARKERS: Record<string, "bold" | "italic" | "strike" | "code"> = { "*": "bold", _: "italic", "~": "strike", "`": "code" };
// WhatsApp only formats a marker that opens a word and closes one: snake_case_word and 2 * 3 * 4 are left alone.
const OPENS_AFTER = /[\s(["'{>]/;
const CLOSES_BEFORE = /[\s.,!?;:)\]"'}<]/;
const SPACE = /\s/;

/**
 * Read WhatsApp's own formatting in a message: *bold*, _italic_, ~strikethrough~ and `monospace`. Returns nodes (never HTML),
 * so nothing a patient or a template contains can inject markup. Run it line by line (a marker never spans lines).
 */
export function parseWhatsAppText(src: string): TextNode[] {
  const nodes: TextNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) nodes.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const kind = MARKERS[ch];
    if (kind && (i === 0 || OPENS_AFTER.test(src[i - 1]!)) && i + 1 < src.length && !SPACE.test(src[i + 1]!) && src[i + 1] !== ch) {
      let close = -1;
      for (let j = i + 2; j < src.length; j++) {
        if (src[j] === ch && !SPACE.test(src[j - 1]!) && (j + 1 === src.length || CLOSES_BEFORE.test(src[j + 1]!))) {
          close = j;
          break;
        }
      }
      if (close > 0) {
        flush();
        const inner = src.slice(i + 1, close);
        nodes.push(kind === "code" ? { type: "code", text: inner } : { type: kind, children: parseWhatsAppText(inner) });
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return nodes;
}
