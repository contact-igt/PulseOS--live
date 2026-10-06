"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import { Button, Skeleton } from "@pulseos/ui";
import type { CommunicationEndpointVm } from "@pulseos/types";

// Super Admin, CCS IVR: what each IVR line IS (a campaign, a health camp, the main reception, a newspaper ad) and who each
// CCS agent is. Nothing is assumed to be a digital campaign: the sources offered are whatever the hospital has defined, and a
// line left on "Phone (default)" simply counts as Phone.

const field = "h-11 w-full rounded-control border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-primary-500 sm:h-9";
const labelCls = "block text-xs text-ink-2";

const errorText = (e: unknown, fallback: string): string => {
  const code = (e as ApiError | undefined)?.message;
  if (code === "forbidden") return "Only a Super Admin can change this.";
  if (code === "provider_ref_already_exists") return "A line with this number already exists.";
  if (code === "source_not_found" || code === "department_not_found" || code === "branch_not_found" || code === "user_not_found") return "That choice is no longer available. Reload and pick again.";
  return fallback;
};

function useOptions(connectorId: string) {
  const sources = useQuery({ queryKey: ["lead-sources", "ivr-lines"], queryFn: () => api.leadSources() });
  const departments = useQuery({ queryKey: ["departments", "ivr-lines"], queryFn: () => api.departments() });
  const branches = useQuery({ queryKey: ["branches", "ivr-lines"], queryFn: () => api.branches() });
  const members = useQuery({ queryKey: ["agent-mapping-options", connectorId], queryFn: () => api.agentMappingOptions(connectorId) });
  return { sources: sources.data ?? [], departments: (departments.data ?? []).filter((d) => !d.archived), branches: branches.data ?? [], members: members.data ?? [] };
}
type Options = ReturnType<typeof useOptions>;

function Attribution({ idPrefix, source, detail, department, branch, onChange, options }: {
  idPrefix: string;
  source: string;
  detail: string;
  department: string;
  branch: string;
  onChange: (patch: Partial<{ source: string; detail: string; department: string; branch: string }>) => void;
  options: Options;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className={labelCls} htmlFor={`${idPrefix}-source`}>
        {idPrefix === "new" ? "New line source" : "Source"}
        <select id={`${idPrefix}-source`} aria-label={idPrefix === "new" ? "New line source" : "Source"} value={source} onChange={(e) => onChange({ source: e.target.value })} className={`mt-1 ${field}`}>
          <option value="">Phone (default)</option>
          {options.sources.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        {idPrefix === "new" ? "New line source detail" : "Source detail"}
        <input aria-label={idPrefix === "new" ? "New line source detail" : "Source detail"} value={detail} maxLength={120} onChange={(e) => onChange({ detail: e.target.value })} placeholder="Camp name, ad, partner (optional)" className={`mt-1 ${field}`} />
      </label>
      <label className={labelCls}>
        Department
        <select aria-label={idPrefix === "new" ? "New line department" : "Department"} value={department} onChange={(e) => onChange({ department: e.target.value })} className={`mt-1 ${field}`}>
          <option value="">Not set</option>
          {options.departments.map((d) => (
            <option key={d.id} value={d.id}>{d.displayName}</option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        Branch
        <select aria-label={idPrefix === "new" ? "New line branch" : "Branch"} value={branch} onChange={(e) => onChange({ branch: e.target.value })} className={`mt-1 ${field}`}>
          <option value="">Not set</option>
          {options.branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function LineRow({ line, connectorId, options }: { line: CommunicationEndpointVm; connectorId: string; options: Options }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ source: line.leadSourceId ?? "", detail: line.sourceDetail ?? "", department: line.departmentId ?? "", branch: line.branchId ?? "" });
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateCommunicationEndpoint(connectorId, line.id, {
        leadSourceId: draft.source || null,
        sourceDetail: draft.detail.trim() || null,
        departmentId: draft.department || null,
        branchId: draft.branch || null,
      }),
    onSuccess: () => {
      setMessage("Saved.");
      queryClient.invalidateQueries({ queryKey: ["ivr-lines", connectorId] });
    },
    onError: (e) => setMessage(errorText(e, "Could not save the line. Check the values and try again.")),
  });
  return (
    <li className="space-y-2 px-3 py-3" data-testid={`line-row-${line.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink">{line.displayLabel}</span>
        <span className="font-mono text-[11px] text-ink-3">{line.publicNumber}</span>
      </div>
      <Attribution idPrefix={line.id} {...draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} options={options} />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => { setMessage(null); save.mutate(); }}>
          {save.isPending ? "Saving…" : "Save line"}
        </Button>
        {message && <span role="status" className="text-xs text-ink-2">{message}</span>}
      </div>
    </li>
  );
}

function AddLine({ connectorId, options }: { connectorId: string; options: Options }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [draft, setDraft] = useState({ source: "", detail: "", department: "", branch: "" });
  const [message, setMessage] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.createCommunicationEndpoint(connectorId, {
        connectorId,
        type: "PHONE",
        displayLabel: name.trim(),
        publicNumber: number.trim(),
        providerRef: `line-${number.replace(/\D/g, "")}`,
        leadSourceId: draft.source || null,
        sourceDetail: draft.detail.trim() || null,
        departmentId: draft.department || null,
        branchId: draft.branch || null,
      }),
    onSuccess: () => {
      setMessage("Line added.");
      setName("");
      setNumber("");
      setDraft({ source: "", detail: "", department: "", branch: "" });
      queryClient.invalidateQueries({ queryKey: ["ivr-lines", connectorId] });
    },
    onError: (e) => setMessage(errorText(e, "Could not add the line. Check the values and try again.")),
  });
  return (
    <div className="space-y-2 rounded-card border border-line bg-surface p-3">
      <span className="block text-xs font-semibold text-ink">Add a line</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className={labelCls}>
          Line name
          <input aria-label="Line name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Main reception, Health camp, Newspaper ad" className={`mt-1 ${field}`} />
        </label>
        <label className={labelCls}>
          Phone number
          <input aria-label="Phone number" value={number} maxLength={30} onChange={(e) => setNumber(e.target.value)} placeholder="As shown in CCS, e.g. 080 4000 5678" className={`mt-1 ${field}`} />
        </label>
      </div>
      <Attribution idPrefix="new" {...draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} options={options} />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          disabled={add.isPending}
          onClick={() => {
            if (!name.trim() || !number.replace(/\D/g, "")) return setMessage("Enter a name and a phone number.");
            setMessage(null);
            add.mutate();
          }}
        >
          {add.isPending ? "Adding…" : "Add line"}
        </Button>
        {message && <span role="status" className="text-xs text-ink-2">{message}</span>}
      </div>
    </div>
  );
}

function AgentMappings({ connectorId, options }: { connectorId: string; options: Options }) {
  const queryClient = useQueryClient();
  const mappings = useQuery({ queryKey: ["agent-mappings", connectorId], queryFn: () => api.agentMappings(connectorId) });
  const [agent, setAgent] = useState("");
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-mappings", connectorId] });
  const map = useMutation({
    mutationFn: () => api.setAgentMapping(connectorId, { externalAgent: agent.trim(), userId }),
    onSuccess: () => {
      setMessage("Agent mapped.");
      setAgent("");
      setUserId("");
      refresh();
    },
    onError: (e) => setMessage(errorText(e, "Could not map the agent. Try again.")),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteAgentMapping(connectorId, id), onSuccess: refresh });
  return (
    <section className="space-y-2" aria-labelledby="agents-heading">
      <h3 id="agents-heading" className="text-xs font-semibold text-ink">CCS agents and team members</h3>
      <p className="text-[11px] text-ink-3">When CCS reports who answered, PulseOS records that team member as the person who handled the call. This does not change who owns a journey.</p>
      {mappings.isLoading ? (
        <Skeleton className="h-10" />
      ) : (mappings.data ?? []).length === 0 ? (
        <p className="text-xs text-ink-2">No agents mapped yet. Until you map one, calls show the name CCS sends.</p>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface text-xs">
          {(mappings.data ?? []).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2" data-testid={`agent-row-${m.id}`}>
              <span>
                <span className="font-medium text-ink">{m.externalAgent}</span> <span className="text-ink-3">is</span> <span className="font-medium text-ink">{m.userName}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)} disabled={remove.isPending}>
                Remove<span className="sr-only"> mapping for {m.externalAgent}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className={labelCls}>
          CCS agent name
          <input aria-label="CCS agent name" value={agent} maxLength={80} onChange={(e) => setAgent(e.target.value)} placeholder="Exactly as CCS shows it" className={`mt-1 ${field}`} />
        </label>
        <label className={labelCls}>
          Team member
          <select aria-label="Team member" value={userId} onChange={(e) => setUserId(e.target.value)} className={`mt-1 ${field}`}>
            <option value="">Choose a person</option>
            {options.members.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="primary" disabled={map.isPending} onClick={() => (!agent.trim() || !userId ? setMessage("Enter the agent name and choose a team member.") : (setMessage(null), map.mutate()))}>
          Map agent
        </Button>
      </div>
      {message && <p role="status" className="text-xs text-ink-2">{message}</p>}
    </section>
  );
}

export function LinesAndTeam({ connectorId }: { connectorId: string }) {
  const options = useOptions(connectorId);
  const lines = useQuery({ queryKey: ["ivr-lines", connectorId], queryFn: () => api.communicationEndpoints(connectorId) });
  return (
    <div className="space-y-5 text-sm" data-testid="lines-and-team">
      <section className="space-y-2" aria-labelledby="lines-heading">
        <h3 id="lines-heading" className="text-xs font-semibold text-ink">IVR lines and where their calls come from</h3>
        <p className="text-[11px] text-ink-3">
          Each IVR number can stand for something: a campaign, a health camp, a newspaper ad, the main reception. A new enquiry on a line takes that source. Calls on a line you leave on Phone (default) count as Phone.
        </p>
        {lines.isLoading ? (
          <Skeleton className="h-24" />
        ) : (lines.data ?? []).length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-surface p-3 text-xs text-ink-2">No lines yet. Add each IVR number you want attributed.</p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {(lines.data ?? []).map((l) => (
              <LineRow key={`${l.id}:${l.leadSourceId}:${l.sourceDetail}:${l.departmentId}:${l.branchId}`} line={l} connectorId={connectorId} options={options} />
            ))}
          </ul>
        )}
        <AddLine connectorId={connectorId} options={options} />
      </section>
      <AgentMappings connectorId={connectorId} options={options} />
    </div>
  );
}
