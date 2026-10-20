"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { platformApi } from "@pulseos/api-client";
import { PulseMark } from "@pulseos/ui";
import { PlatformShell } from "../../../components/platform/PlatformShell";

/**
 * Every /platform page sits behind a platform session. The API is the boundary (each platform endpoint refuses anyone without a
 * platform session and the right platform permission); this layout renders nothing - no page, no data request - until the
 * session is confirmed, and sends anyone else to the platform sign-in. A hospital session is never accepted here.
 */
export default function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data, isLoading, isError } = useQuery({ queryKey: ["platform-session"], queryFn: platformApi.session, retry: false, staleTime: 60_000 });

  useEffect(() => {
    if (isError) router.replace(`/platform/login?from=${encodeURIComponent(pathname)}`);
  }, [isError, router, pathname]);

  if (isLoading) {
    return (
      <div className="app-shell flex h-screen flex-col items-center justify-center gap-3 text-sm text-ink-2" data-testid="platform-loading">
        <PulseMark size={36} />
        <span>Loading Platform Console…</span>
      </div>
    );
  }
  if (!data) return null;
  return <PlatformShell user={data.user}>{children}</PlatformShell>;
}
