import { redirect } from "next/navigation";

// /treatments is the canonical route (Brain ruling). This keeps any
// bookmarked/linked /treatment URL working instead of breaking silently.
export default function TreatmentRedirectPage() {
  redirect("/treatments");
}
