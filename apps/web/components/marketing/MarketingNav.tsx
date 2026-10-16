"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { PulseLockup } from "@pulseos/ui/src/Brand";
import { NAV_LINKS } from "./content";
import { CONTAINER, DEMO_HREF } from "./ui";

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="glass sticky top-0 z-[var(--z-sticky)] rounded-none border-x-0 border-t-0 border-b border-line">
      <div className={`${CONTAINER} flex h-16 items-center justify-between gap-4`}>
        <Link href="/" aria-label="PulseOS home" className="rounded-control">
          <PulseLockup size={30} showBeta={false} />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="rounded-control px-3.5 py-2 text-[15px] font-medium text-ink-2 transition hover:bg-primary-50 hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden h-10 items-center rounded-control px-3.5 text-[15px] font-medium text-ink transition hover:bg-primary-50 sm:inline-flex">
            Sign in
          </Link>
          <a href={DEMO_HREF} className="inline-flex h-10 items-center rounded-control bg-brand px-4 text-[15px] font-semibold text-white transition hover:bg-primary-700">
            Book demo
          </a>
          <button
            ref={buttonRef}
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-line-strong bg-white text-ink lg:hidden"
            aria-expanded={open}
            aria-controls="mk-mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <nav id="mk-mobile-menu" aria-label="Mobile" className="border-t border-line bg-white lg:hidden">
          <ul className={`${CONTAINER} py-2`}>
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setOpen(false)} className="flex min-h-12 items-center rounded-control px-2 text-base font-medium text-ink hover:bg-primary-50">
                  {l.label}
                </a>
              </li>
            ))}
            <li>
              <Link href="/login" className="flex min-h-12 items-center rounded-control px-2 text-base font-medium text-ink hover:bg-primary-50">
                Sign in
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
