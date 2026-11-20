import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "./providers";

const geist = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-pulseos",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PulseOS",
  description: "Patient Engagement CRM and Hospital Operations Command Centre",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
