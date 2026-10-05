import { beforeEach, describe, expect, it } from "vitest";
import { journeyCrumbs, patientCrumbs, readListUrl, recordListUrl, rootCrumb } from "../breadcrumbs";

// A breadcrumb says where you are in the PulseOS domain, never in the URL: the root is the list you came from (by its
// ?from= key), the next crumb is the Patient, and the Journey (the enquiry - "Cataract") is the page you are on.
// Patient and Journey are different things and are never merged or renamed to "Customer".

const memory = () => {
  const store = new Map<string, string>();
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
};

describe("rootCrumb", () => {
  it.each([
    ["leads", "Leads", "/leads"],
    ["patients", "Patients", "/patients"],
    ["journeys", "Journeys", "/journeys"],
    ["treatments", "Treatments", "/treatments"],
    ["appointments", "Appointments", "/appointments"],
    ["my-work", "My Work", "/my-work"],
    ["command-centre", "Command Centre", "/command-centre"],
  ])("%s -> %s", (from, label, href) => {
    expect(rootCrumb(from, { label: "x", href: "/x" })).toEqual({ label, href });
  });

  it("falls back to the page's own default for no key, an unknown key or a prototype key", () => {
    const fb = { label: "Journeys", href: "/journeys" };
    for (const f of [null, "", "nope", "https://evil.example", "//evil", "constructor", "__proto__"]) expect(rootCrumb(f, fb)).toEqual(fb);
  });

  it("returns the list URL it last saw (filters, page) for that key, so Back lands where you were", () => {
    const s = memory();
    recordListUrl(s, "leads", "/leads?view=follow_up_due&range=7d&page=2");
    expect(rootCrumb("leads", { label: "x", href: "/x" }, s)).toEqual({ label: "Leads", href: "/leads?view=follow_up_due&range=7d&page=2" });
  });
});

describe("list context", () => {
  let s: ReturnType<typeof memory>;
  beforeEach(() => {
    s = memory();
  });

  it("remembers the list URL per list and nothing else", () => {
    recordListUrl(s, "leads", "/leads?status=new");
    recordListUrl(s, "treatments", "/treatments?status=SCHEDULED");
    expect(readListUrl(s, "leads")).toBe("/leads?status=new");
    expect(readListUrl(s, "treatments")).toBe("/treatments?status=SCHEDULED");
    expect(readListUrl(s, "patients")).toBeNull();
  });

  it("only keeps a URL that is that list's own path (no other path, no other origin, no protocol-relative link)", () => {
    for (const bad of ["https://evil.example/leads", "//evil.example/leads", "/patients?x=1", "/leads/../patients", "javascript:alert(1)", "/leads\\evil", "/leadsX?a=1", "/leads?" + "a".repeat(2100)]) {
      recordListUrl(s, "leads", bad);
      expect(readListUrl(s, "leads"), bad).toBeNull();
    }
  });

  it("a tampered stored value is never returned", () => {
    s.setItem("pulseos.list.leads", "https://evil.example");
    expect(readListUrl(s, "leads")).toBeNull();
  });

  it("works without storage (private mode, server)", () => {
    expect(() => recordListUrl(null, "leads", "/leads")).not.toThrow();
    expect(readListUrl(null, "leads")).toBeNull();
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(() => recordListUrl(throwing, "leads", "/leads")).not.toThrow();
    expect(readListUrl(throwing, "leads")).toBeNull();
  });
});

describe("journeyCrumbs: Leads > Patient > Cataract", () => {
  const patient = { id: "p1", name: "Suresh Kulkarni" };
  const journey = { id: "j1", journeyType: "Cataract" };

  it("from the Leads list: the root is Leads (with its filters), then the Patient, then the enquiry", () => {
    const s = memory();
    recordListUrl(s, "leads", "/leads?view=uncontacted&range=7d");
    expect(journeyCrumbs({ from: "leads", patient, journey, storage: s })).toEqual([
      { label: "Leads", href: "/leads?view=uncontacted&range=7d" },
      { label: "Suresh Kulkarni", href: "/patients/p1?from=leads" },
      { label: "Cataract" },
    ]);
  });

  it("from a patient list or a treatment: the root follows where the person came from", () => {
    expect(journeyCrumbs({ from: "patients", patient, journey }).map((c) => c.label)).toEqual(["Patients", "Suresh Kulkarni", "Cataract"]);
    expect(journeyCrumbs({ from: "treatments", patient, journey }).map((c) => c.label)).toEqual(["Treatments", "Suresh Kulkarni", "Cataract"]);
    expect(journeyCrumbs({ from: "appointments", patient, journey }).map((c) => c.label)).toEqual(["Appointments", "Suresh Kulkarni", "Cataract"]);
  });

  it("with no source the root is Journeys", () => {
    expect(journeyCrumbs({ from: null, patient, journey }).map((c) => c.label)).toEqual(["Journeys", "Suresh Kulkarni", "Cataract"]);
  });

  it("the Patient crumb carries the same root forward, and the last crumb is the page (no link)", () => {
    const crumbs = journeyCrumbs({ from: "my-work", patient, journey });
    expect(crumbs[1]!.href).toBe("/patients/p1?from=my-work");
    expect(crumbs.at(-1)!.href).toBeUndefined();
  });

  it("never calls a Patient a Customer", () => {
    for (const f of ["leads", "patients", null]) expect(JSON.stringify(journeyCrumbs({ from: f, patient, journey }))).not.toMatch(/customer/i);
  });
});

describe("patientCrumbs: Patients > Patient", () => {
  const patient = { id: "p1", name: "Suresh Kulkarni" };

  it("is the list you came from, then the Patient as the page", () => {
    expect(patientCrumbs({ from: "patients", patient })).toEqual([{ label: "Patients", href: "/patients" }, { label: "Suresh Kulkarni" }]);
    expect(patientCrumbs({ from: "leads", patient }).map((c) => c.label)).toEqual(["Leads", "Suresh Kulkarni"]);
  });

  it("defaults to Patients", () => {
    expect(patientCrumbs({ from: null, patient }).map((c) => c.label)).toEqual(["Patients", "Suresh Kulkarni"]);
  });

  it("a patient with no name still gets a page crumb", () => {
    expect(patientCrumbs({ from: null, patient: { id: "p1", name: "" } }).at(-1)!.label).toBe("Patient");
  });
});
