import Link from "next/link";
import { PulseLockup } from "@pulseos/ui/src/Brand";
import { CONTAINER } from "./ui";

const LINKS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#journey" },
  { label: "For hospitals", href: "#roles" },
  { label: "Security", href: "#security-title" },
  { label: "Contact", href: "#demo" },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-white py-10">
      <div className={`${CONTAINER} flex flex-col gap-8 md:flex-row md:items-start md:justify-between`}>
        <div className="max-w-sm">
          <PulseLockup size={28} showBeta={false} />
          <p className="mt-3 text-sm leading-relaxed text-ink-2">Patient engagement and revenue intelligence for hospitals and clinics. Works alongside your existing EMR or HMIS.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            {LINKS.map((l) => (
              <li key={l.label}>
                <a href={l.href} className="inline-flex min-h-11 items-center text-[15px] text-ink-2 hover:text-ink">{l.label}</a>
              </li>
            ))}
            <li>
              <Link href="/login" className="inline-flex min-h-11 items-center text-[15px] font-medium text-ink hover:text-brand">Sign in</Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
