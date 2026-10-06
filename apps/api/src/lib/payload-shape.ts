// The SHAPE of a payload: every field name (nested ones too), and the value only for fields whose NAME says they are a category
// (status wording, direction, circle...). Everything else becomes a type placeholder. This is what is kept of a provider payload
// PulseOS could not read as a call, so the real shape can be inspected without storing the call's data (a phone, a name, a URL).

// Field names where a handful of distinct values is useful to see. Never a phone, a name or a URL.
export const CATEGORY_FIELDS = new Set(["status", "callstatus", "dialstatus", "callstate", "disposition", "direction", "calltype", "type", "event", "eventtype", "circle", "telecomcircle", "callgroup", "group", "ivrkey", "key", "keypress", "dtmf", "keypressed", "ivrselection", "menuoption", "selection", "hangupcause", "errorcode"]);
const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
const lastName = (path: string) => path.split(/[.\[\]]+/).filter(Boolean).pop() ?? path;
export const isCategoryName = (path: string): boolean => CATEGORY_FIELDS.has(norm(lastName(path)));
const isPlaceholder = (v: string) => /^\[(string|number|boolean|null|object|array)\]$/.test(v);

const MAX_DEPTH = 4;

export function shapeOf(value: unknown, key = "", depth = 0): unknown {
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? "[array]" : value.length ? [shapeOf(value[0], key, depth + 1)] : [];
  if (value !== null && typeof value === "object") {
    return depth >= MAX_DEPTH ? "[object]" : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, k, depth + 1)]));
  }
  if (value === null || value === undefined) return "[null]";
  return isCategoryName(key) ? String(value).slice(0, 40) : `[${typeof value}]`;
}

/** Walks a shape OR a real payload and yields each leaf as a dotted path (arrays as `name[]`) with its category-like value, if any. */
export function* leaves(value: unknown, path = "", depth = 0): Generator<{ path: string; value: string | null }> {
  if (Array.isArray(value)) {
    if (value.length && depth < MAX_DEPTH) yield* leaves(value[0], `${path}[]`, depth + 1);
    else if (path) yield { path, value: null };
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) yield* leaves(v, path ? `${path}.${k}` : k, depth + 1);
    return;
  }
  const text = value === null || value === undefined ? null : String(value);
  yield { path, value: text !== null && isCategoryName(path) && !isPlaceholder(text) ? text.slice(0, 40) : null };
}
