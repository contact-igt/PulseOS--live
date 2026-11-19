"use client";

import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { platformApi } from "@pulseos/api-client";
import { AuditTable, buttonClass, date, Failure, inputClass, label, Loading, PageControls, panelClass, secondaryClass, usePlatformAccount, usePlatformQuery } from "../../platform-ui";

const reasons = ["SECURITY", "OPERATIONS", "COMPLIANCE", "SERVICE_RESTORED", "OTHER"] as const;

export default function HospitalLifecycle({ id, legacy }: { id: string; legacy: boolean }) {
  const cache = useQueryClient();
  const account = usePlatformAccount();
  const [page, setPage] = useState(1);
  const [reason, setReason] = useState<(typeof reasons)[number]>("OPERATIONS");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [confirmationAction, setConfirmationAction] = useState<"suspend" | "restore">("suspend");
  const confirmation = useRef<HTMLDialogElement>(null);
  const version = useRef(0);
  const query = usePlatformQuery(["lifecycle", id, String(legacy)], () => platformApi.lifecycle(id, legacy));
  const history = usePlatformQuery(["lifecycle-history", id, String(legacy), String(page)], () => platformApi.lifecycleHistory(id, legacy, page));
  const operations = useQuery({
    queryKey: ["platform", "lifecycle-operations", id, String(legacy)],
    queryFn: () => platformApi.lifecycleOperations(id, legacy), retry: false,
    refetchInterval: (query) => query.state.data?.messaging?.latest?.status === "pending" ? 5000 : false,
  });
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failure error={query.error} />;
  const lifecycle = query.data;
  const action = lifecycle.status === "ACTIVE" ? "suspend" : lifecycle.status === "SUSPENDED" ? "restore" : null;
  const allowed = action && account.data?.permissions.includes(action === "suspend" ? "hospital:suspend" : "hospital:restore");
  const messaging = operations.data?.messaging;
  const command = messaging?.latest;
  const pairingChanged = messaging?.bindingCurrent === false;
  const canCoordinate = account.data?.permissions.includes(lifecycle.status === "ACTIVE" ? "hospital:restore" : "hospital:suspend");

  async function coordinate(action: "retry" | "resume") {
    if (pending || (action === "resume" && !window.confirm("Authorize WhatsNexus messaging to resume for this hospital?"))) return;
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      await platformApi.coordinateMessaging(id, legacy, action, lifecycle.version);
      setNotice("WhatsNexus coordination queued.");
      await cache.invalidateQueries({ queryKey: ["platform"] });
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  async function replay() {
    if (pending || !window.confirm("Recover up to five eligible Meta Lead Ads references for this hospital? This creates enquiry work.")) return;
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await platformApi.replayHeldMetaLeads(id, legacy, lifecycle.version);
      setNotice(`Meta leads processed ${result.processed}, failed ${result.failed}, skipped ${result.skipped}.`);
      await cache.invalidateQueries({ queryKey: ["platform"] });
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const action = confirmationAction;
    const explanation = String(new FormData(event.currentTarget).get("explanation") ?? "").trim();
    setPending(true);
    setError(undefined);
    setNotice("");
    try {
      await platformApi.changeLifecycle(id, legacy, action, { version: version.current, reason, ...(explanation ? { explanation } : {}) });
      confirmation.current?.close();
      setPage(1);
      setNotice(action === "suspend" ? "Hospital suspended." : "Hospital restored. Staff must sign in again.");
      await cache.invalidateQueries({ queryKey: ["platform"] });
    } catch (failure) {
      setError(failure);
      confirmation.current?.close();
      await cache.invalidateQueries({ queryKey: ["platform"] });
    } finally {
      setPending(false);
    }
  }

  return <section className={panelClass + " mt-5 space-y-4"}>
    <h2 className="text-lg font-semibold">Hospital lifecycle</h2>
    <dl className="grid gap-3 sm:grid-cols-3">
      <div><dt>Status</dt><dd className="font-medium">{label(lifecycle.status.toLowerCase())}</dd></div>
      <div><dt>Login availability</dt><dd className="font-medium">{lifecycle.loginEnabled ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Last lifecycle change</dt><dd className="font-medium">{date(lifecycle.changedAt)}</dd></div>
    </dl>
    {lifecycle.suspension && <p>Suspension reason: {label(lifecycle.suspension.reason.toLowerCase())}{lifecycle.suspension.explanation && " — " + lifecycle.suspension.explanation}</p>}
    {operations.isPending && <Loading />}
    {operations.isError && <Failure error={operations.error} />}
    {operations.data && <div className="space-y-2 border-t border-neutral-200 pt-4">
      <h3 className="font-semibold">Integration operations</h3>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt>WhatsNexus messaging</dt><dd>{(pairingChanged ? null : command?.observation?.state) ?? (operations.data.providerCoordination === "external_pause_unverified" ? "External pause unverified" : "No WhatsNexus connector")}</dd></div>
        {operations.data.connector && <>
          <div><dt>Recorded connector status</dt><dd>{label(operations.data.connector.status.toLowerCase())} · {operations.data.connector.mode}</dd></div>
          <div><dt>Paired WhatsNexus tenant</dt><dd className="break-all">{operations.data.connector.remoteTenantId ?? "Unavailable"}</dd></div>
          <div><dt>Last connector sync</dt><dd>{date(operations.data.connector.lastSyncAt)}</dd></div>
        </>}
        <div><dt>Held Meta leads</dt><dd>{operations.data.heldInbound}</dd></div>
        {Boolean(operations.data.expiringMetaLeads) && <div><dt>Meta leads expiring within 24 hours</dt><dd>{operations.data.expiringMetaLeads}</dd></div>}
        {Boolean(operations.data.exhaustedMetaLeads) && <div><dt>Meta leads with exhausted retries</dt><dd>{operations.data.exhaustedMetaLeads}</dd></div>}
        <div><dt>Queued outbound work</dt><dd>{operations.data.queuedOutbound}</dd></div>
        <div><dt>Unresolved dispatches</dt><dd>{operations.data.unresolvedDispatches}</dd></div>
        <div><dt>Oldest queued record</dt><dd>{date(operations.data.oldestPendingAt)}</dd></div>
        <div><dt>Verified provider health check</dt><dd>{operations.data.lastVerifiedProviderHealthAt ? date(operations.data.lastVerifiedProviderHealthAt) : "No recorded check"}</dd></div>
        <div><dt>Restoration reconciliation</dt><dd>{label(operations.data.restorationReconciliation)}</dd></div>
      </dl>
      {messaging?.enabled && <>
        {lifecycle.status === "SUSPENDED" && (pairingChanged || command?.observation?.state !== "PAUSED" || command.status !== "confirmed" ||
          command.lifecycleVersion !== lifecycle.version) &&
          <p role="alert" className="font-semibold text-amber-800">PulseOS is suspended. WhatsNexus pause is unconfirmed.</p>}
        {pairingChanged && <p role="alert" className="text-sm text-amber-800">WhatsNexus pairing changed. Previous observations are historical.</p>}
        {!pairingChanged && command?.observation && command.lifecycleVersion !== lifecycle.version &&
          <p className="text-sm text-neutral-600">The displayed observation predates the current hospital lifecycle change.</p>}
        {command && <>
          <p className="text-sm">Last coordination command {label(command.action)} · {label(command.status)} · {command.id}</p>
          <p className="text-sm">Last successful synchronization {command.verifiedAt ? date(command.verifiedAt) : "Pending"}</p>
          {command.error && <p role="alert" className="text-sm text-amber-800">{label(command.error)}</p>}
          {!!command.observation?.unresolvedPermits &&
            <p role="alert" className="text-sm text-amber-800">Unresolved WhatsNexus send permits {command.observation.unresolvedPermits}</p>}
          {canCoordinate && !pairingChanged && command.status === "failed" &&
            <button className={secondaryClass} disabled={pending} onClick={() => coordinate("retry")}>Retry WhatsNexus reconciliation</button>}
          {canCoordinate && !pairingChanged && lifecycle.status === "ACTIVE" && command.action === "pause" && command.status === "confirmed" &&
            <button className={secondaryClass} disabled={pending} onClick={() => coordinate("resume")}>Authorize WhatsNexus resume</button>}
        </>}
        {!!messaging.history.length && <details className="text-sm">
          <summary>WhatsNexus command history</summary>
          <ul>{messaging.history.map((item) => <li key={item.id}>{label(item.action)} · {label(item.status)} · {date(item.createdAt)} · {item.id}</li>)}</ul>
        </details>}
      </>}
      {lifecycle.status === "ACTIVE" && operations.data.heldInbound > 0 && account.data?.permissions.includes("hospital:restore") &&
        <button className={secondaryClass} disabled={pending} onClick={replay}>Review and recover Meta leads</button>}
    </div>}
    {allowed && <button className={secondaryClass} disabled={pending} onClick={() => {
      version.current = lifecycle.version;
      setConfirmationAction(action);
      setReason(action === "restore" ? "SERVICE_RESTORED" : "OPERATIONS");
      confirmation.current?.querySelector("form")?.reset();
      confirmation.current?.showModal();
    }}>{action === "suspend" ? "Suspend hospital" : "Restore hospital"}</button>}
    <dialog ref={confirmation} aria-labelledby="hospital-lifecycle-confirmation" className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl p-6 backdrop:bg-black/50">
      <form onSubmit={submit} className="space-y-4">
        <h3 id="hospital-lifecycle-confirmation" className="text-lg font-semibold">{confirmationAction === "suspend" ? "Confirm suspension" : "Confirm restoration"}</h3>
        <p className="text-sm">{confirmationAction === "suspend"
          ? "This signs out hospital staff, blocks new intake, and pauses scheduled dispatch."
          : "Staff will need to sign in again. Eligible future work can resume. Overdue notifications will be suppressed."}</p>
        <label className="block text-sm">Reason<select required className={inputClass} value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
          {reasons.map((option) => <option key={option} value={option}>{label(option.toLowerCase())}</option>)}
        </select></label>
        <label className="block text-sm">Explanation<textarea name="explanation" className={inputClass} maxLength={240} required={reason === "OTHER"} /></label>
        <p className="text-sm text-neutral-600">Use operational details only. Exclude patient information and credentials.</p>
        <div className="flex gap-3">
          <button type="button" className={secondaryClass} disabled={pending} onClick={() => confirmation.current?.close()}>Cancel</button>
          <button type="submit" className={buttonClass} disabled={pending}>{pending ? "Saving…" : confirmationAction === "suspend" ? "Confirm suspend" : "Confirm restore"}</button>
        </div>
      </form>
    </dialog>
    {error !== undefined && <Failure error={error} />}
    {notice && <p role="status">{notice}</p>}
    {account.data?.permissions.includes("audit:read") && operations.data?.recentAudit && <>
      <h3 className="font-semibold">Recent hospital audit actions</h3>
      <AuditTable events={operations.data.recentAudit} />
    </>}
    <h3 className="font-semibold">Lifecycle history</h3>
    {history.isPending && <Loading />}
    {history.isError && <Failure error={history.error} />}
    {history.data?.items.length === 0 && <p>No lifecycle operations recorded.</p>}
    <ul className="divide-y divide-neutral-200">
      {history.data?.items.map((event) => <li key={event.id} className="py-2 text-sm">
        <span className="font-medium">{label(event.action)} · {label(event.outcome)} · {date(event.createdAt)}</span>
        <p>{event.previousState ? label(event.previousState.toLowerCase()) + " → " : ""}{label(event.requestedState.toLowerCase())}{event.reason && " · " + label(event.reason.toLowerCase())}</p>
        {event.explanation && <p>{event.explanation}</p>}
      </li>)}
    </ul>
    {history.data && (page > 1 || history.data.hasMore) && <PageControls page={page} hasMore={history.data.hasMore} onPage={setPage} />}
  </section>;
}
