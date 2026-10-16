"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@pulseos/api-client";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const qc: QueryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
      // A session that ends while the app is open (expired, or signed out in another tab) shows up as a 401 on whatever the
      // page asked for next. Re-ask the server for the session: that fails too, and the app shell then returns the person to
      // sign-in with the page they were on (the equivalent of WhatsNexus clearing its auth on an expired token). The session
      // query itself is excluded so the sign-in pages' own "am I signed in?" check cannot loop.
      queryCache: new QueryCache({
        onError: (error, query) => {
          if (query.queryKey[0] === "session") return;
          if (error instanceof ApiError && error.status === 401) void qc.invalidateQueries({ queryKey: ["session"] });
        },
      }),
    });
    return qc;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
