import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Self-hosted by Next.js at build time (no runtime request to Google Fonts).
// --font-sans in globals.css referenced "Inter" without ever loading it, so
// every page was silently rendering in the OS system font.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "PulseOS",
  description: "Patient Engagement CRM and Hospital Operations Command Centre",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
