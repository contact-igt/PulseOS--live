import { createHash } from "node:crypto";

// The ONE place CCS Express IVR's raw call report becomes a PulseOS canonical call. Nothing downstream (patients,
// journeys, tasks, analytics) reads a CCS field name.
//
// HONESTY NOTE: PulseOS has not yet received a real CCS webhook, so these field names are CANDIDATES: the columns of the CCS
// dashboard's call report plus common IVR call-record vocabulary. Matching ignores case and separators ("Caller Number",
// caller_number and callerNumber are one name). Whatever is not recognised is preserved in `unmapped` (credentials removed,
// values capped), so the first real payload can be mapped from what CCS actually sends rather than from guesses.

export interface CcsCanonicalCall {
  provider: "CCS_EXPRESS_IVR";
  /** Idempotency identity: unique per provider call. */
  providerEventId: string;
  providerCallId: string;
  /** True when CCS sent no call id and the identity was derived from the call's own details. */
  idDerived: boolean;
  direction: "inbound" | "outbound";
  callerPhone: string;
  /** The IVR / deskphone line that took (or placed) the call, as CCS reports it. */
  calledLine: string | null;
  agent: string | null;
  callGroup: string | null;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  outcome: "answered" | "missed" | "no_answer" | "busy" | "failed";
  /** CCS's own status wording, untouched. */
  providerDisposition: string | null;
  /** Telecom circle: provider metadata only. It is NOT the patient's location. */
  circle: string | null;
  ivrSelection: string | null;
  customerName: string | null;
  recordingAvailable: boolean;
  /** For the protected recording store only. Never put it in metadata, a response or a log. */
  recordingRef: string | null;
  unmapped: Record<string, unknown>;
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// Candidate aliases, normalised (lowercase, alphanumerics only). Order = priority.
const ALIASES = {
  callId: ["callid", "uniqueid", "uuid", "id", "sessionid", "calluuid", "sid", "cdrid", "callsid"],
  caller: ["callernumber", "callerno", "caller", "callerid", "customernumber", "customerno", "customerphone", "phonenumber", "phone", "mobile", "from", "cli", "callingnumber"],
  calledLine: ["callednumber", "calledno", "called", "calledline", "dialednumber", "dnis", "ivrnumber", "ivrno", "deskphone", "deskphonenumber", "did", "virtualnumber"],
  agent: ["agentname", "agentnumber", "agent", "membername", "member", "membernumber", "executive", "operator", "user", "extension", "answeredby"],
  callGroup: ["callgroup", "group", "groupname", "queue"],
  startedAt: ["starttime", "calltime", "datetime", "createdat", "startdate", "calldate", "calldatetime", "timestamp", "time"],
  answeredAt: ["answertime", "answeredat", "answerat", "connecttime"],
  endedAt: ["endtime", "enddate", "endedat", "hangupat", "hanguptime"],
  duration: ["duration", "callduration", "talkduration", "durationseconds", "billsec", "talktime"],
  status: ["status", "callstatus", "dialstatus", "callstate", "disposition"],
  direction: ["direction", "calltype", "type"],
  circle: ["circle", "telecomcircle", "operatorcircle"],
  ivrSelection: ["ivrkey", "dtmf", "keypressed", "keypress", "ivrselection", "menuoption", "digit", "digits", "selection"],
  recording: ["recordingurl", "recording", "recordurl", "audiourl", "fileurl", "callrecording", "recordfile", "voicerecord"],
  customerName: ["customername", "callername", "name"],
} as const;

const CREDENTIAL_KEYS = new Set(["apikey", "key", "secret", "secretkey", "integrationkey", "token", "accesstoken", "authorization", "password", "signature"]);
const RECOGNISED = new Set<string>(Object.values(ALIASES).flat());

function pick(index: Map<string, unknown>, names: readonly string[]): unknown {
  for (const n of names) {
    const v = index.get(n);
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}
const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null);

export function parseCcsDuration(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const words = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/i.exec(s);
  if (words && (words[1] || words[2] || words[3])) return Number(words[1] ?? 0) * 3600 + Number(words[2] ?? 0) * 60 + Number(words[3] ?? 0);
  return null;
}

const IST_OFFSET = "+05:30";
const pad = (n: string | number, w = 2) => String(n).padStart(w, "0");

/** CCS reports India local time without an offset: zoneless text is read as IST. An explicit offset or Z is honoured. */
export function parseCcsTimestamp(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) return parseCcsTimestamp(Number(s));
  const done = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  // ISO-like: 2026-10-06 19:49:10 | 2026-10-06T19:49:10 | ...Z | ...+05:30
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (iso) {
    const off = iso[7] ? (iso[7].toUpperCase() === "Z" ? "Z" : iso[7].includes(":") ? iso[7] : `${iso[7].slice(0, 3)}:${iso[7].slice(3)}`) : IST_OFFSET;
    return done(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? "00"}${off}`);
  }
  // Indian day-first: 06-10-2026 19:49:10 | 06/10/2026 07:49 PM
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (dmy) {
    let h = Number(dmy[4] ?? 0);
    const mer = dmy[7]?.toUpperCase();
    if (mer === "PM" && h < 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    return done(`${dmy[3]}-${pad(dmy[2]!)}-${pad(dmy[1]!)}T${pad(h)}:${pad(dmy[5] ?? 0)}:${pad(dmy[6] ?? 0)}${IST_OFFSET}`);
  }
  return null;
}

function outcomeOf(statusRaw: string, direction: "inbound" | "outbound", durationSeconds: number | null): CcsCanonicalCall["outcome"] {
  const s = statusRaw.toLowerCase();
  const unanswered = /(no[\s_-]*answer|unanswer|not[\s_-]*answer|miss|abandon|not[\s_-]*pick|no[\s_-]*pick)/.test(s);
  // An inbound call nobody answered IS a missed call (someone is waiting for a callback). An outbound call the patient did
  // not pick up is not: it stays no_answer and creates no "missed call" work.
  if (unanswered) return direction === "inbound" ? "missed" : "no_answer";
  if (/busy/.test(s)) return "busy";
  if (/fail/.test(s)) return "failed";
  if (/(answer|complete|connect|pick|success)/.test(s) || s === "1") return "answered";
  return (durationSeconds ?? 0) > 0 ? "answered" : direction === "inbound" ? "missed" : "no_answer";
}

const cap = (v: unknown): unknown => {
  if (v !== null && typeof v === "object") return JSON.stringify(v).slice(0, 300);
  return typeof v === "string" ? v.slice(0, 300) : v;
};

export function normalizeCcsCall(raw: unknown, opts: { now?: Date } = {}): CcsCanonicalCall | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = opts.now ?? new Date();
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const nk = key(k);
    if (!index.has(nk)) index.set(nk, v); // first spelling wins
  }

  const callerPhone = str(pick(index, ALIASES.caller));
  if (!callerPhone) return null;

  const dirRaw = String(pick(index, ALIASES.direction) ?? "inbound").toLowerCase();
  const direction: "inbound" | "outbound" = /out/.test(dirRaw) ? "outbound" : "inbound";
  const durationSeconds = parseCcsDuration(pick(index, ALIASES.duration));
  const statusRaw = str(pick(index, ALIASES.status));
  const startedAt = parseCcsTimestamp(pick(index, ALIASES.startedAt));
  const calledLine = str(pick(index, ALIASES.calledLine));
  const agent = str(pick(index, ALIASES.agent));
  const recordingRef = str(pick(index, ALIASES.recording));

  let providerCallId = str(pick(index, ALIASES.callId));
  let idDerived = false;
  if (!providerCallId) {
    // No id from CCS: derive a stable one from what identifies the call, so a retry of the same report cannot duplicate it.
    // Without a start time the minute of arrival stands in; two distinct calls inside one minute from one caller to one line
    // would merge, which is the lesser harm compared with duplicating every retry.
    const when = startedAt?.toISOString() ?? now.toISOString().slice(0, 16);
    const digest = createHash("sha256").update([callerPhone.replace(/\D/g, ""), calledLine ?? "", when, durationSeconds ?? "", agent ?? ""].join("|")).digest("hex").slice(0, 20);
    providerCallId = digest;
    idDerived = true;
  }

  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const nk = key(k);
    if (RECOGNISED.has(nk) || CREDENTIAL_KEYS.has(nk)) continue;
    unmapped[k] = cap(v);
  }

  return {
    provider: "CCS_EXPRESS_IVR",
    providerEventId: idDerived ? `ccs:derived:${providerCallId}` : `ccs:event:${providerCallId}`,
    providerCallId,
    idDerived,
    direction,
    callerPhone,
    calledLine,
    agent,
    callGroup: str(pick(index, ALIASES.callGroup)),
    startedAt,
    answeredAt: parseCcsTimestamp(pick(index, ALIASES.answeredAt)),
    endedAt: parseCcsTimestamp(pick(index, ALIASES.endedAt)),
    durationSeconds,
    outcome: outcomeOf(statusRaw ?? "", direction, durationSeconds),
    providerDisposition: statusRaw,
    circle: str(pick(index, ALIASES.circle)),
    ivrSelection: str(pick(index, ALIASES.ivrSelection)),
    customerName: str(pick(index, ALIASES.customerName)),
    recordingAvailable: !!recordingRef,
    recordingRef,
    unmapped,
  };
}
