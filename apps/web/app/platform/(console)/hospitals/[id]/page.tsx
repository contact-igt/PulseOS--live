import HospitalDetails from "./hospital-details";

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ legacy?: string }>;
}) {
  return <HospitalDetails id={(await params).id} legacy={(await searchParams).legacy === "1"} />;
}
