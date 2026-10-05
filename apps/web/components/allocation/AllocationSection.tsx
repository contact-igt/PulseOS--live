"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@pulseos/ui";
import type { SpecialtyTemplateVm } from "@pulseos/types";
import { FormError } from "@/components/settings/FormBits";
import { AllocationRuleSheet } from "./AllocationRuleSheet";
import { blankRule, ruleSummary, ruleToForm, type RuleForm } from "./allocationForm";

/**
 * Settings → Allocation Rules. New enquiries are offered to the rules in order; the first match chooses
 * who owns the journey (taking turns inside a team). Assigning or reassigning by hand always works.
 */
export function AllocationSection({ services }: { services: SpecialtyTemplateVm[] }) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["allocation-rules"], queryFn: api.allocationRules });
  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups, staleTime: 60_000 });
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; form: RuleForm; id?: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["allocation-rules"] });

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(fallback);
    }
  }
  const list = rules.data ?? [];
  const move = (i: number, d: -1 | 1) => {
    const ids = list.map((r) => r.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return run(() => api.reorderAllocationRules(ids), "Couldn't reorder that rule — try again.");
  };
  const btn = "inline-flex h-11 w-9 items-center justify-center rounded-control text-ink-2 hover:bg-primary-50 hover:text-ink disabled:opacity-30 sm:h-8 sm:w-7";

  return (
    <div className="space-y-4" data-testid="allocation-section">
      <p className="max-w-2xl text-xs leading-relaxed text-ink-2">
        Decide which team member a new enquiry is assigned to. Rules are tried from the top; the first one that matches picks the team member. If none match, the enquiry stays unassigned until someone takes it. You can always assign or reassign a journey by hand.
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setEditing({ mode: "create", form: blankRule() })} data-testid="allocation-add">
          <Plus size={14} aria-hidden="true" /> Add rule
        </Button>
      </div>
      <FormError message={error} testId="allocation-section-error" />
      {rules.isLoading && <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
      {rules.isError && <ErrorState message="Could not load allocation rules." />}
      {rules.data && list.length === 0 && <EmptyState message="No rules yet." hint="Without rules, new enquiries start unassigned." action={<Button variant="primary" onClick={() => setEditing({ mode: "create", form: blankRule() })}>Add rule</Button>} />}
      {list.length > 0 && (
        <ol className="divide-y divide-line overflow-hidden rounded-card border border-line bg-white" data-testid="allocation-list">
          {list.map((r, i) => (
            <li key={r.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${r.enabled ? "" : "bg-neutral-50 text-ink-2"}`} data-testid={`allocation-row-${r.id}`}>
              <div className="flex shrink-0 items-center">
                <button type="button" className={btn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`} data-testid={`allocation-move-up-${r.id}`}>
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button type="button" className={btn} disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`} data-testid={`allocation-move-down-${r.id}`}>
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
              </div>
              <button type="button" className="min-w-0 flex-1 basis-48 text-left" onClick={() => setEditing({ mode: "edit", form: ruleToForm(r), id: r.id })} aria-label={`Edit ${r.name}`}>
                <span className="block truncate text-sm font-medium text-ink">{r.name}</span>
                <span className="block text-[11px] text-ink-2">{ruleSummary(r, services, lookups.data?.branches ?? [])}</span>
              </button>
              {!r.enabled && <Badge>Off</Badge>}
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => run(() => api.updateAllocationRule(r.id, { enabled: !r.enabled }), "Couldn't change that rule — try again.")} data-testid={`allocation-toggle-${r.id}`}>
                  {r.enabled ? "Turn off" : "Turn on"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: "edit", form: ruleToForm(r), id: r.id })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting({ id: r.id, name: r.name })} data-testid={`allocation-delete-${r.id}`}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <AllocationRuleSheet
          mode={editing.mode}
          initial={editing.form}
          ruleId={editing.id}
          services={services}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `Delete "${deleting.name}"?` : ""}
        description="New enquiries will no longer be assigned by this rule. Journeys already assigned keep their assigned team member."
        confirmLabel="Delete rule"
        onConfirm={() => {
          const d = deleting;
          setDeleting(null);
          if (d) void run(() => api.deleteAllocationRule(d.id), "Couldn't delete that rule — try again.");
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
