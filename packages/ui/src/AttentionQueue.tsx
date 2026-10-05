import type { AttentionItem } from "@pulseos/types";
import { Badge, EmptyState, Panel } from "./primitives";
import { ATTENTION_REASON_LABEL as REASON_LABEL } from "./status";
import { urgencyLabel } from "./format";

/**
 * The operational queue: what needs a person right now. Each row names the
 * patient and journey, the reason (as a labelled badge), who owns it and how
 * overdue it is; the whole row opens the journey. Urgency is always text
 * ("1d overdue"), the dot is only a redundant cue.
 */
export function AttentionQueue({ items, onItemClick }: { items: AttentionItem[]; onItemClick?: (item: AttentionItem) => void }) {
  const overdueCount = items.filter((i) => urgencyLabel(i.dueAt).overdue).length;
  return (
    <Panel
      title="Attention / SLA"
      subtitle={`${items.length} need action`}
      action={overdueCount > 0 ? <Badge tone="danger">{overdueCount} overdue</Badge> : undefined}
      padded={false}
      className="h-full"
      data-testid="attention-queue"
    >
      {items.length === 0 ? (
        <EmptyState message="Nothing needs attention right now" />
      ) : (
        // Container query, not viewport: the panel is 60% wide on desktop and full
        // width on a phone, so the layout follows the panel. Wide (>=34rem): one
        // aligned row of fixed columns. Narrow: two lines, so the reason chip,
        // owner and due time never share a line with a truncated patient name.
        <div className="@container">
          <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
            {items.map((item) => {
              const urgency = urgencyLabel(item.dueAt);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onItemClick?.(item)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-left transition hover:bg-primary-50 focus-visible:-outline-offset-2 @[34rem]:grid-cols-[minmax(0,1.5fr)_10.75rem_minmax(0,0.75fr)_5.5rem]"
                    data-testid={`attention-row-${item.id}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${urgency.overdue ? "bg-danger-500" : "bg-warning-500"}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{item.patientName}</span>
                        <span className="block truncate text-xs text-ink-2">{item.journeyType}</span>
                      </span>
                    </span>
                    <span className={`shrink-0 text-right text-xs font-medium tabular-nums @[34rem]:order-4 ${urgency.overdue ? "text-danger-700" : "text-ink-2"}`}>{urgency.text}</span>
                    <span className="col-span-2 flex min-w-0 items-center gap-2 pl-3.5 @[34rem]:contents">
                      <span className="min-w-0 shrink-0 @[34rem]:order-2">
                        <Badge tone={urgency.overdue ? "warning" : "neutral"}>{REASON_LABEL[item.reason]}</Badge>
                      </span>
                      <span className="min-w-0 truncate text-xs text-ink-2 @[34rem]:order-3">{item.ownerName ?? "Unassigned"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
