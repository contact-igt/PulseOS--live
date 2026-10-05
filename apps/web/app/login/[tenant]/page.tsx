import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TenantBrandedLogin, WorkspaceNotFound } from "@/components/login/TenantBrandedLogin";
import { TenantLoginForm } from "@/components/login/TenantLoginForm";
import { fetchTenantBranding } from "@/lib/tenantBranding";

// /login/<slug> - a hospital's own sign-in. The page is resolved on the SERVER from the slug alone (the browser never supplies a
// tenant id); the same approved layout serves every hospital and only safe branding data differs. A name that is not a workspace
// is a generic 404 that says nothing about any hospital.

type Params = { params: Promise<{ tenant: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { tenant } = await params;
  const r = await fetchTenantBranding(tenant);
  return r.status === "ok" ? { title: `Sign in · ${r.branding.displayName}` } : { title: "Sign in · PulseOS", robots: { index: false } };
}

export default async function TenantLoginPage({ params }: Params) {
  const { tenant } = await params;
  const result = await fetchTenantBranding(tenant);
  if (result.status === "not_found") notFound();
  if (result.status === "unavailable") return <WorkspaceNotFound unavailable />;
  return (
    <TenantBrandedLogin branding={result.branding}>
      <TenantLoginForm slug={result.branding.slug} />
    </TenantBrandedLogin>
  );
}
