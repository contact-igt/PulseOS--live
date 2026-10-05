import type { QueryClient } from "@tanstack/react-query";

/** Everything that shows a journey's owner: lists, summaries, the detail page, Patient 360 and the dashboards. */
export function invalidateJourneyQueries(queryClient: QueryClient) {
  for (const key of ["leads", "leads-summary", "journeys", "journeys-summary", "journey", "patient360", "dashboard"]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}
