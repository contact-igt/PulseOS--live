import type { FollowUpDefaultOwner } from "@pulseos/types";

/** Who a follow-up goes to by default, in the hospital's wording ("Assigned Team Member" is the canonical term). */
export const FOLLOW_UP_DEFAULT_LABEL: Record<FollowUpDefaultOwner, string> = {
  JOURNEY_OWNER: "Journey's assigned team member",
  ACTOR: "The person adding it",
  UNASSIGNED: "Unassigned",
};
