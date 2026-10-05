import { FIELD_GROUPS, type JourneyCustomFieldVm } from "@pulseos/types";

const GROUP_LABEL = new Map<string, string>(FIELD_GROUPS.map((g) => [g.key, g.label]));
const GROUP_ORDER = new Map<string, number>(FIELD_GROUPS.map((g, i) => [g.key, i]));

/**
 * Recorded CRM field values, grouped under their configured sections (the server already filtered by
 * placement and role). Section headings appear only when there is more than one section.
 */
export function CustomFieldValueGrid({ fields, testId = "custom-field-values", className = "" }: { fields: JourneyCustomFieldVm[]; testId?: string; className?: string }) {
  if (fields.length === 0) return null;
  const groups: { key: string; items: JourneyCustomFieldVm[] }[] = [];
  for (const f of fields) {
    const key = f.groupKey ?? "other";
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(f);
    else groups.push({ key, items: [f] });
  }
  groups.sort((a, b) => (GROUP_ORDER.get(a.key) ?? 99) - (GROUP_ORDER.get(b.key) ?? 99));

  return (
    <div className={`space-y-3 ${className}`} data-testid={testId}>
      {groups.map((g) => (
        <div key={g.key}>
          {groups.length > 1 && <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">{GROUP_LABEL.get(g.key) ?? "Other"}</h4>}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {g.items.map((f, i) => (
              <div key={f.fieldKey ?? `${f.label}-${i}`} className="min-w-0">
                <dt className="truncate text-[11px] text-ink-2">{f.label}</dt>
                <dd className="truncate text-sm text-ink" title={f.value}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
