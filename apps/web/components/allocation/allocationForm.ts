import { SOURCE_LABELS } from "@pulseos/ui";
import type { AllocationRuleVm, CreateAllocationRuleInput, SourceChannel } from "@pulseos/types";

// Pure helpers behind Settings → Allocation Rules.

export interface RuleForm {
  name: string;
  /** "" = any */
  source: SourceChannel | "";
  specialtyKey: string;
  journeyType: string;
  branchId: string;
  userIds: string[];
  enabled: boolean;
}

export const blankRule = (): RuleForm => ({ name: "", source: "", specialtyKey: "", journeyType: "", branchId: "", userIds: [], enabled: true });

export const ruleToForm = (r: AllocationRuleVm): RuleForm => ({
  name: r.name,
  source: r.source ?? "",
  specialtyKey: r.specialtyKey ?? "",
  journeyType: r.journeyType ?? "",
  branchId: r.branchId ?? "",
  userIds: r.pool.map((p) => p.userId),
  enabled: r.enabled,
});

export const formToInput = (f: RuleForm): CreateAllocationRuleInput => ({
  name: f.name.trim(),
  source: f.source || null,
  specialtyKey: f.specialtyKey || null,
  journeyType: f.journeyType.trim() || null,
  branchId: f.branchId || null,
  userIds: f.userIds,
  enabled: f.enabled,
});

export function validateRuleForm(f: RuleForm): string | null {
  if (!f.name.trim()) return "Give the rule a name.";
  if (!f.source && !f.specialtyKey && !f.journeyType.trim() && !f.branchId) return "Choose when this rule applies: at least a source, service, journey type or branch.";
  if (f.userIds.length === 0) return "Choose who should receive these leads.";
  return null;
}

export function ruleSummary(r: AllocationRuleVm, services: { key: string; displayName: string }[], branches: { id: string; name: string }[]): string {
  const when = [
    r.source ? (SOURCE_LABELS[r.source] ?? r.source) : null,
    r.specialtyKey ? (services.find((s) => s.key === r.specialtyKey)?.displayName ?? r.specialtyKey) : null,
    r.journeyType,
    r.branchId ? (branches.find((b) => b.id === r.branchId)?.name ?? "a branch") : null,
  ].filter(Boolean);
  const who = r.pool.map((p) => p.name).join(", ");
  return `${when.join(" · ")} → ${who}${r.pool.length > 1 ? " (taking turns)" : ""}`;
}
