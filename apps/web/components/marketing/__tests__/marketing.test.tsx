import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LandingPage from "../../../app/(marketing)/page";
import MarketingLayout from "../../../app/(marketing)/layout";
import { MarketingNav } from "../MarketingNav";
import { RoleStory } from "../RoleStory";
import { PatientJourneyDemo } from "../PatientJourneyDemo";
import { WorkflowConfigurator } from "../WorkflowConfigurator";
import { HookStory } from "../HookStory";
import { DemoRequestForm, buildDemoMailto } from "../DemoRequestForm";
import { HOOK_STAGES, INTEGRATIONS, NAV_LINKS, ROLES } from "../content";
import { STORY_STEPS, changedAt, eventsAt, funnelAt } from "../journeyStory";

describe("marketing nav", () => {
  it("links the four sections; Sign in goes to /login and Book demo to the demo section", () => {
    render(<MarketingNav />);
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual(NAV_LINKS.map((l) => [l.label, l.href]));
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "Book demo" }).getAttribute("href")).toBe("#demo");
  });

  it("opens the mobile menu with a button, closes it with Escape and when a link is chosen", () => {
    render(<MarketingNav />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("navigation", { name: "Mobile" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Mobile" })).getByRole("link", { name: "How it works" }));
    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();
  });
});

describe("journey story model", () => {
  it("starts from the hook's 42 and adds the patient only where she has reached", () => {
    expect(funnelAt(0)).toEqual([43, 27, 21, 18, 9, 6, 4]);
    expect(funnelAt(1)).toEqual([43, 27, 21, 18, 9, 6, 4]);
    expect(funnelAt(2)).toEqual([43, 28, 21, 18, 9, 6, 4]);
    expect(funnelAt(3)).toEqual([43, 28, 22, 18, 9, 6, 4]);
    expect(funnelAt(4)).toEqual([43, 28, 22, 19, 10, 6, 4]);
    expect(HOOK_STAGES.map((s) => s.count)).toEqual([42, 27, 21, 18, 9, 6, 4]);
  });

  it("flags exactly the rows that moved at each step", () => {
    expect(changedAt(0)).toEqual([0]);
    expect(changedAt(1)).toEqual([]);
    expect(changedAt(2)).toEqual([1]);
    expect(changedAt(3)).toEqual([2]);
    expect(changedAt(4)).toEqual([3, 4]);
  });

  it("accumulates timeline events chronologically and never loses an earlier one", () => {
    for (let i = 1; i < STORY_STEPS.length; i++) expect(eventsAt(i).slice(0, eventsAt(i - 1).length)).toEqual(eventsAt(i - 1));
    expect(eventsAt(4).map((e) => e.title)).toContain("Procedure advised");
  });
});

describe("interactive patient journey", () => {
  it("advances with the in-product action button, updates the timeline and the owner funnel, then replays", () => {
    render(<PatientJourneyDemo />);
    expect(screen.getByTestId("journey-count-0").textContent).toBe("43");
    expect(screen.getByTestId("journey-action").textContent).toContain("Log the call");
    fireEvent.click(screen.getByTestId("journey-action"));
    expect(screen.getByTestId("journey-timeline").textContent).toContain("Call connected");
    fireEvent.click(screen.getByTestId("journey-action")); // Confirm appointment
    expect(screen.getByTestId("journey-count-1").textContent).toBe("28");
    expect(screen.getByTestId("journey-timeline").textContent).toContain("Appointment confirmed");
    fireEvent.click(screen.getByTestId("journey-action")); // Check in
    expect(screen.getByTestId("journey-timeline").textContent).toContain("Waiting · 8 min");
    expect(screen.getByTestId("journey-action").textContent).toContain("Send to doctor");
    fireEvent.click(screen.getByTestId("journey-action"));
    expect(screen.getByTestId("journey-timeline").textContent).toContain("Procedure advised");
    expect(screen.getByTestId("journey-count-4").textContent).toBe("10");
    expect(screen.getByTestId("journey-next-action").textContent).toContain("Coordinator follow-up");
    fireEvent.click(screen.getByTestId("journey-action")); // Replay
    expect(screen.getByTestId("journey-count-0").textContent).toBe("43");
    expect(screen.getByTestId("journey-count-4").textContent).toBe("9");
  });

  it("is keyboard operable (tabs with arrows) and states the reminder dependency", () => {
    render(<PatientJourneyDemo />);
    const list = screen.getByRole("tablist", { name: "Journey chapters" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByTestId("journey-timeline").textContent).toMatch(/provider is connected/);
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getAllByRole("tab")[4]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tab")[0]!.getAttribute("tabindex")).toBe("-1");
  });
});

describe("role story", () => {
  it("changes copy and visual on click, keeps tab semantics", () => {
    render(<RoleStory />);
    expect(screen.getByTestId("role-headline").textContent).toBe(ROLES[0].headline);
    fireEvent.click(screen.getByRole("tab", { name: "Front desk" }));
    expect(screen.getByTestId("role-headline").textContent).toBe(ROLES[1].headline);
    expect(screen.getByText("Waiting · 8 min", { selector: "dt" })).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("role-tab-frontdesk");
    fireEvent.click(screen.getByRole("tab", { name: "Doctor" }));
    expect(screen.getByText("Today · Dr. Menon")).toBeTruthy();
    expect(screen.queryByText("Hospital performance")).toBeNull(); // no marketing metrics in the doctor view
  });

  it("supports arrow, Home and End keys and wraps around", () => {
    render(<RoleStory />);
    const list = screen.getByRole("tablist", { name: "Choose a role" });
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByTestId("role-headline").textContent).toBe(ROLES[1].headline);
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getByTestId("role-headline").textContent).toBe(ROLES[3].headline);
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByTestId("role-headline").textContent).toBe(ROLES[0].headline);
  });
});

describe("hook story", () => {
  it("shows the whole 42 → 4 staircase as content, labelled as example data", () => {
    render(<HookStory />);
    expect(screen.getAllByLabelText("What happened to 42 enquiries (example data)")).toHaveLength(2);
    expect(screen.getByText(/Example journey data \(synthetic\)/)).toBeTruthy();
    for (const s of HOOK_STAGES) expect(screen.getAllByText(s.label).length).toBeGreaterThan(0);
  });
});

describe("workflow configurator", () => {
  it("toggles fields in the Add Lead preview", () => {
    render(<WorkflowConfigurator />);
    const preview = () => screen.getByTestId("add-lead-preview").textContent ?? "";
    expect(preview()).toContain("Area");
    expect(preview()).not.toContain("Date of Birth");
    fireEvent.click(screen.getByRole("switch", { name: "Show Date of Birth on Add Lead" }));
    expect(preview()).toContain("Date of Birth");
    fireEvent.click(screen.getByRole("switch", { name: "Show Area on Add Lead" }));
    expect(preview()).not.toContain("Area");
    expect(screen.getByTestId("intake-states").textContent).toContain("UID");
  });
});

describe("demo request form", () => {
  const fill = () => {
    for (const [label, value] of [["Name", "Dr Rao"], ["Hospital / Clinic", "Lakeview Eye"], ["Phone", "+91 90000 00000"], ["Work email", "rao@lakeview.example"]] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
  };

  it("builds a mailto that carries every field the visitor typed", () => {
    const url = buildDemoMailto("demo@example.test", { name: "Dr Rao", hospital: "Lakeview Eye", phone: "+91 90000 00000", email: "rao@lakeview.example" });
    expect(url.startsWith("mailto:demo@example.test?subject=PulseOS%20demo%20request&body=")).toBe(true);
    const body = decodeURIComponent(url.split("body=")[1]!);
    for (const v of ["Dr Rao", "Lakeview Eye", "+91 90000 00000", "rao@lakeview.example"]) expect(body).toContain(v);
  });

  it("opens the request when a destination is configured", () => {
    const open = vi.fn();
    render(<DemoRequestForm to="demo@example.test" open={open} />);
    fill();
    fireEvent.submit(screen.getByTestId("demo-form"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("demo-form-status").textContent).toMatch(/email app should now be open/);
  });

  it("never silently discards: with no destination it says so and sends nothing", () => {
    const open = vi.fn();
    render(<DemoRequestForm to="" open={open} />);
    fill();
    fireEvent.submit(screen.getByTestId("demo-form"));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId("demo-form-status").textContent).toMatch(/nothing was sent/);
  });
});

describe("landing page content", () => {
  const renderPage = () => render(<MarketingLayout><LandingPage /></MarketingLayout>);

  it("has one h1, an ordered heading outline and only the two CTA concepts", () => {
    renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Know what happened after every patient enquiry.");
    const levels = screen.getAllByRole("heading").map((h) => Number(h.tagName[1]));
    levels.reduce((prev, cur) => {
      expect(cur - prev).toBeLessThanOrEqual(1);
      return cur;
    });
    expect(screen.getAllByRole("link", { name: "Book a live demo" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Watch a patient journey" }).getAttribute("href")).toBe("#journey");
    for (const banned of [/get started/i, /start now/i, /try now/i, /talk to sales/i, /free access/i]) expect(document.body.textContent).not.toMatch(banned);
  });

  it("renders the public shell only: no app sidebar or developer login", () => {
    renderPage();
    expect(screen.queryByTestId("dev-login-block")).toBeNull();
    expect(screen.queryByText(/Developer access/i)).toBeNull();
    expect(document.querySelector(".app-sidebar")).toBeNull();
  });

  it("makes no unsupported claims and avoids filler words", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    for (const banned of [/HIPAA/i, /NABH/i, /ABDM/i, /ISO ?27001/i, /AI-powered/i, /revolutioni[sz]e/i, /cutting-edge/i, /seamless/i, /leverage/i, /empower/i, /transform/i, /next-generation/i, /\bNamokar\b/i, /guaranteed/i, /#1\b/, /\bbest\b/i, /free trial/i, /replace your EMR/i]) {
      expect(text).not.toMatch(banned);
    }
    expect(text).toMatch(/Independent research, not a PulseOS result/);
    expect(text).not.toMatch(/PulseOS reduces no-shows/i);
  });

  it("never shows an integration as Connected and only uses the three honest states", () => {
    const { container } = renderPage();
    expect(INTEGRATIONS.every((i) => ["Works today", "Integration-ready", "On request"].includes(i.state))).toBe(true);
    expect(container.textContent).not.toMatch(/\bConnected\b/);
    expect(INTEGRATIONS.find((i) => i.category === "EMR / HMIS")?.state).toBe("On request");
  });

  it("labels every number block as synthetic or illustrative", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).toMatch(/Example journey data \(synthetic\)/);
    expect(text).toMatch(/Illustrative data\. Not customer results/);
    expect(text).toMatch(/Illustrative numbers on synthetic data/);
  });

  it("cites the reminder study with a link to the source", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /Robotham et al\./ });
    expect(link.getAttribute("href")).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC5093388/");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("describes only the product in structured data (no ratings, reviews or prices)", () => {
    const { container } = renderPage();
    const json = container.querySelector('script[type="application/ld+json"]')?.textContent ?? "";
    const data = JSON.parse(json);
    expect(data["@graph"].map((n: { "@type": string }) => n["@type"])).toEqual(["SoftwareApplication", "Organization"]);
    expect(json).not.toMatch(/aggregateRating|review|offers|price/i);
  });
});
