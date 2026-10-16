import { Hero } from "../../components/marketing/Hero";
import { HookStory } from "../../components/marketing/HookStory";
import { PatientJourneyDemo } from "../../components/marketing/PatientJourneyDemo";
import { OldWayStory } from "../../components/marketing/OldWayStory";
import { OwnerStory } from "../../components/marketing/OwnerStory";
import { RoleStory } from "../../components/marketing/RoleStory";
import { InlineAppointmentStory } from "../../components/marketing/InlineAppointmentStory";
import { WorkflowConfigurator } from "../../components/marketing/WorkflowConfigurator";
import { SystemMap } from "../../components/marketing/SystemMap";
import { AttributionStory } from "../../components/marketing/AttributionStory";
import { OperationsProof } from "../../components/marketing/OperationsProof";
import { FinalCta } from "../../components/marketing/FinalCta";

// Structured data: describes the product and the organisation only. No ratings, reviews, prices or customer counts.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "PulseOS",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: "Patient engagement and hospital operations platform: enquiries, calls, follow-ups, appointments, consultations and procedures in one connected patient journey.",
    },
    { "@type": "Organization", name: "PulseOS" },
  ],
};

export default function LandingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Hero />
      <HookStory />
      <PatientJourneyDemo />
      <OldWayStory />
      <OwnerStory />
      <RoleStory />
      <InlineAppointmentStory />
      <WorkflowConfigurator />
      <SystemMap />
      <AttributionStory />
      <OperationsProof />
      <FinalCta />
    </>
  );
}
