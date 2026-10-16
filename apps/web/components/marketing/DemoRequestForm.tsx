"use client";

import { useState, type FormEvent } from "react";
import { DEMO_REQUEST_EMAIL } from "./content";

export type DemoRequest = { name: string; hospital: string; phone: string; email: string };

/** Builds the mailto the form opens. Exported for tests; every field the visitor typed is in the body (nothing dropped). */
export function buildDemoMailto(to: string, r: DemoRequest): string {
  const body = [`Name: ${r.name}`, `Hospital / Clinic: ${r.hospital}`, `Phone: ${r.phone}`, `Work email: ${r.email}`].join("\n");
  return `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent("PulseOS demo request")}&body=${encodeURIComponent(body)}`;
}

const INPUT = "h-12 w-full rounded-control border border-line-strong bg-white px-3.5 text-[16px] text-ink outline-none transition placeholder:text-neutral-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25";

export function DemoRequestForm({ to = DEMO_REQUEST_EMAIL, open }: { to?: string; open?: (url: string) => void }) {
  const [status, setStatus] = useState<"idle" | "opened" | "unconfigured">("idle");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const req: DemoRequest = { name: String(f.get("name") ?? ""), hospital: String(f.get("hospital") ?? ""), phone: String(f.get("phone") ?? ""), email: String(f.get("email") ?? "") };
    if (!to) {
      setStatus("unconfigured");
      return;
    }
    (open ?? ((u) => window.location.assign(u)))(buildDemoMailto(to, req));
    setStatus("opened");
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="demo-form" aria-describedby="demo-form-note">
      <div>
        <label htmlFor="demo-name" className="mb-1.5 block text-sm font-medium text-ink">Name</label>
        <input id="demo-name" name="name" required autoComplete="name" className={INPUT} />
      </div>
      <div>
        <label htmlFor="demo-hospital" className="mb-1.5 block text-sm font-medium text-ink">Hospital / Clinic</label>
        <input id="demo-hospital" name="hospital" required autoComplete="organization" className={INPUT} />
      </div>
      <div>
        <label htmlFor="demo-phone" className="mb-1.5 block text-sm font-medium text-ink">Phone</label>
        <input id="demo-phone" name="phone" type="tel" required autoComplete="tel" className={INPUT} />
      </div>
      <div>
        <label htmlFor="demo-email" className="mb-1.5 block text-sm font-medium text-ink">Work email</label>
        <input id="demo-email" name="email" type="email" required autoComplete="email" className={INPUT} />
      </div>
      <div className="sm:col-span-2">
        <button type="submit" className="inline-flex h-12 w-full items-center justify-center rounded-control bg-brand px-6 text-[15px] font-semibold text-white transition hover:bg-primary-700">
          Book a Live Demo
        </button>
        <p id="demo-form-note" role="status" className="mt-3 text-sm leading-relaxed text-ink-2" data-testid="demo-form-status">
          {status === "idle" && "Submitting opens your email app with this request ready to send. Nothing is stored until you send it."}
          {status === "opened" && "Your email app should now be open with the request ready to send. If nothing opened, email us the same details from any mail app."}
          {status === "unconfigured" && "Demo requests aren't connected on this site yet, so nothing was sent. Please contact your PulseOS representative directly."}
        </p>
      </div>
    </form>
  );
}
