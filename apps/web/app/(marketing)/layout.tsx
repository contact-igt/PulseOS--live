import type { Metadata } from "next";
import { headers } from "next/headers";
import { MarketingNav } from "../../components/marketing/MarketingNav";
import { MarketingFooter } from "../../components/marketing/MarketingFooter";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3310";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "PulseOS — Patient Engagement & Hospital Operations Platform";
  const description = "Know what happened after every patient enquiry: one connected operational view for hospitals and clinics.";
  const image = { url: "/assets/PulseOS.png", width: 1213, height: 910, alt: "PulseOS patient engagement platform" };

  return {
    metadataBase: new URL(origin),
    title: { absolute: title },
    description: "Track patient enquiries, calls, follow-ups, appointments, consultations and procedures in one connected hospital patient journey.",
    keywords: ["hospital patient engagement platform", "hospital CRM", "hospital lead management", "patient journey management", "hospital follow-up software", "hospital appointment management", "healthcare CRM India"],
    openGraph: { type: "website", siteName: "PulseOS", url: origin, title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/** Public marketing shell: its own nav and footer, none of the signed-in app chrome (sidebar, dev login, internal nav). */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mk-site min-h-screen bg-white text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-overlay)] focus:rounded-control focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-glass">
        Skip to content
      </a>
      <MarketingNav />
      <main id="main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
