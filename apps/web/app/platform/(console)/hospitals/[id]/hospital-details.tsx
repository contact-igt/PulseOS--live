"use client";

import HospitalLifecycle from "./hospital-lifecycle";
import HospitalArchivalAssessmentPanel from "./hospital-archival-assessment";
import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { buttonClass, date, Failure, label, Loading, PageTitle, panelClass, secondaryClass, usePlatformAccount } from "../../platform-ui";

const readiness: Record<string, string> = {
  login_slug_required: "Assign a login slug.",
  administrator_branch_required: "Assign the first hospital Super Admin to a branch in this hospital.",
  profile_required: "Complete the hospital profile.",
  branding_required: "Create the branded login configuration.",
  invitation_acceptance_required: "The first hospital administrator must accept their invitation.",
  template_installation_required: "Finish installing the department template.",
};

export default function HospitalDetails({ id, legacy }: { id: string; legacy: boolean }) {
  const account = usePlatformAccount();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["platform", "hospital", id, String(legacy)],
    queryFn: () => platformApi.hospital(id, legacy), retry: false,
    refetchInterval: (current) => current.state.data?.invitationDelivery?.status === "pending" ? 5000 : false,
  });
  const resendRequest = useRef<string | null>(null);
  const [issued, setIssued] = useState<{ link: string; recipient: string; expiresAt: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");

  async function run(action: "invitation" | "invitation-resend" | "retry-template" | "activate") {
    setWorking(true);
    setError(undefined);
    setNotice("");
    setIssued(null);
    try {
      if (action === "invitation-resend") {
        resendRequest.current ??= crypto.randomUUID();
        await platformApi.resendHospitalInvitation(id, resendRequest.current);
        resendRequest.current = null;
        setNotice("Invitation email queued.");
      } else if (action === "invitation") {
        const result = await platformApi.hospitalInvitation(id);
        setIssued({ link: new URL(result.invitationPath, window.location.origin).href, recipient: result.recipient, expiresAt: result.expiresAt });
      } else {
        const { hospital } = await platformApi.hospitalAction(id, action);
        setNotice(action === "activate" ? "Hospital activated." : hospital.template === "failed" ? "The template failed again. You can retry installation." : "Template installed.");
      }
      void cache.invalidateQueries({ queryKey: ["platform"] });
    } catch (failure) {
      setError(failure);
      void query.refetch();
    } finally {
      setWorking(false);
    }
  }

  if (query.isPending) return <Loading />;
  if (query.isError) return <Failure error={query.error} />;
  const hospital = query.data;
  const permissions = account.data?.permissions ?? [];
  const delivery = hospital.invitationDelivery;
  const deliveryLabel = delivery?.status === "accepted" ? "Email provider accepted"
    : delivery?.status === "pending" ? (delivery.attempts ? "Delivery attempted. Retry pending." : "Delivery pending")
      : delivery?.status === "failed" ? "Delivery failed" : delivery?.status === "expired" ? "Invitation expired"
        : delivery?.status === "superseded" ? "Delivery superseded" : "Email not queued";
  return <>
    <PageTitle title={hospital.name ?? "Hospital onboarding"}><Link className={secondaryClass} href="/platform/hospitals">Hospital directory</Link></PageTitle>
    <dl className={panelClass + " grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
      {[
        ["Provisioning", label(hospital.provisioning)], ["Login", hospital.active ? "Active" : "Disabled"],
        ["Login slug", hospital.slug ?? "Pending"], ["Edition", hospital.edition ?? "Pending"],
        ["Department template", label(hospital.template)], ["Administrator invitation", label(hospital.invitation)],
        ...(delivery ? [["Invitation email", deliveryLabel], ["Invitation expires", date(delivery.expiresAt)],
          ["Last email attempt", date(delivery.lastAttemptAt ?? null)]] : []),
        ["Created", date(hospital.createdAt)], ["Onboarding ID", hospital.onboardingId ?? "—"],
        ["Hospital tenant ID", hospital.tenantId ?? "Pending"],
      ].map(([term, value]) => <div key={term}><dt className="text-sm text-neutral-600">{term}</dt><dd className="break-all font-medium">{value}</dd></div>)}
      {hospital.loginPath && <div><dt className="text-sm text-neutral-600">Branded sign-in</dt><dd>
        {hospital.active ? <Link className="text-primary-700 underline" href={hospital.loginPath}>{hospital.loginPath}</Link> : hospital.loginPath}
      </dd></div>}
    </dl>
    {hospital.provisioningError && <p className="mt-4 text-sm text-red-700" role="alert">Provisioning failed. {hospital.provisioningError === "email_in_use" ? "The owner email is in use." : hospital.provisioningError === "invalid_phone" ? "The phone number was invalid." : "Retry using the original hospital creation request."}</p>}
    {delivery?.failure && <p role="alert" className="mt-3 text-sm text-amber-800">Invitation email: {label(delivery.failure)}.</p>}
    {hospital.tenantId && permissions.includes("hospital:lifecycle:read") && <HospitalLifecycle id={id} legacy={legacy} />}
    {hospital.tenantId && account.data?.role === "PLATFORM_SUPER_ADMIN" && permissions.includes("hospital:lifecycle:read")
      && <HospitalArchivalAssessmentPanel id={id} legacy={legacy} />}
    {!legacy && <section className={panelClass + " mt-5 space-y-3"}>
      <h2 className="text-lg font-semibold">Onboarding readiness</h2>
      {hospital.ready ? <p>All activation requirements are met.</p> : <ul className="list-disc space-y-1 pl-5 text-sm">
        {hospital.readinessFailures?.map((reason) => <li key={reason}>{readiness[reason] ?? "Review this activation requirement with PulseOS support."}</li>)}
      </ul>}
      <div className="flex flex-wrap gap-3">
        {permissions.includes("hospital:retry") && ["pending", "failed"].includes(hospital.template) && <button className={secondaryClass} disabled={working} onClick={() => run("retry-template")}>Retry department template</button>}
        {delivery?.enabled && account.data?.role === "PLATFORM_SUPER_ADMIN" && permissions.includes("hospital:invite") &&
          hospital.tenantId && !hospital.active && hospital.invitation !== "accepted" &&
          <button className={secondaryClass} disabled={working} onClick={() => run("invitation-resend")}>Resend invitation email</button>}
        {!delivery?.enabled && permissions.includes("hospital:invite") && hospital.tenantId && hospital.invitation !== "accepted" && <button className={secondaryClass} disabled={working} onClick={() => run("invitation")}>
          {hospital.invitation === "not_issued" ? "Issue administrator invitation" : "Replace administrator invitation"}
        </button>}
        {permissions.includes("hospital:activate") && !hospital.active && hospital.lifecycleStatus !== "SUSPENDED" && hospital.lifecycleStatus !== "ARCHIVED" && <button className={buttonClass} disabled={working || !hospital.ready} onClick={() => run("activate")}>Activate hospital</button>}
      </div>
      {error !== undefined && <Failure error={error} />}
      {notice && <p role="status">{notice}</p>}
      {issued && <div className="space-y-2 rounded-control border border-neutral-200 p-4">
        <p className="text-sm">Send this one-time link securely to {issued.recipient}. It expires {date(issued.expiresAt)}. Replacing an invitation invalidates its previous link.</p>
        <label className="block text-sm">Hospital administrator invitation link<input readOnly value={issued.link} className="mt-1 w-full rounded-control border p-2" /></label>
        <button className={secondaryClass} onClick={() => setIssued(null)}>Hide link</button>
      </div>}
    </section>}
  </>;
}
