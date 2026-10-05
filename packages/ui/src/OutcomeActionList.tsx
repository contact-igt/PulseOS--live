"use client";

import { useState, type ReactNode } from "react";
import type { ConsultationOutcomeValue, DoctorTodayItem, TreatmentDefinitionVm } from "@pulseos/types";
import { Badge, Button, EmptyState, FilterSelect, Panel } from "./primitives";
import { fmtTime } from "./format";

// One simple OPERATIONAL outcome per consultation (what happens next for the patient), not a clinical record. Procedure
// scheduling is not here: it goes through the existing surgery flow once the procedure is advised.
const ACTIONS: { outcome: ConsultationOutcomeValue; label: string }[] = [
  { outcome: "CONSULTED", label: "Consultation Completed" },
  { outcome: "NO_TREATMENT_REQUIRED", label: "No treatment needed" },
  { outcome: "FOLLOW_UP_REQUIRED", label: "Review / follow-up" },
  { outcome: "TREATMENT_ADVISED", label: "Surgery / procedure advised" },
  { outcome: "DECISION_PENDING", label: "Patient is deciding" },
  { outcome: "TREATMENT_DECLINED", label: "Patient declined" },
];

// Outcomes that open (or close) a Treatment Opportunity on the API, so the doctor says which one.
const OUTCOMES_WITH_TREATMENT: ConsultationOutcomeValue[] = ["TREATMENT_ADVISED", "DECISION_PENDING", "TREATMENT_DECLINED"];

const OUTCOME_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.outcome, a.label])) as Record<ConsultationOutcomeValue, string>;

/** What the doctor picked for the treatment: a catalog procedure, or a free-text label when the catalog is empty. */
export type OutcomeTreatmentChoice = { treatmentDefinitionId: string } | { treatmentLabel: string };

const textFieldClass =
  "glass-control h-8 min-w-0 flex-1 rounded-control px-2.5 text-xs text-ink outline-none transition placeholder:text-neutral-500 focus-visible:border-primary-500";

export function OutcomeActionList({
  items,
  onRecord,
  pendingAppointmentId,
  getTreatmentOptions,
  title = "Awaiting outcome",
  emptyMessage = "Nothing awaiting an outcome",
  renderPatientLink,
}: {
  items: DoctorTodayItem[];
  onRecord: (appointmentId: string, outcome: ConsultationOutcomeValue, treatment?: OutcomeTreatmentChoice) => void;
  pendingAppointmentId?: string | null;
  /**
   * The tenant's treatment catalog for this appointment's journey specialty (GET /treatment-catalog).
   * When provided, Treatment Advised / Decision Pending ask which treatment: a select of catalog
   * procedures, or a free-text field only if the catalog is empty. When omitted the outcome records at once.
   */
  getTreatmentOptions?: (item: DoctorTodayItem) => TreatmentDefinitionVm[];
  title?: string;
  emptyMessage?: string;
  /** Wrap the patient name in a link (the package is router-free, so the page supplies its own Link). */
  renderPatientLink?: (item: DoctorTodayItem, children: ReactNode) => ReactNode;
}) {
  const [picking, setPicking] = useState<{ appointmentId: string; outcome: ConsultationOutcomeValue } | null>(null);
  const [definitionId, setDefinitionId] = useState("");
  const [freeText, setFreeText] = useState("");

  function closePicker() {
    setPicking(null);
    setDefinitionId("");
    setFreeText("");
  }

  return (
    <Panel title={title} subtitle={`${items.length}`} padded={false} data-testid="outcome-action-list">
      {items.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const isPending = pendingAppointmentId === item.appointmentId;
            const options = getTreatmentOptions?.(item);
            const picker = picking?.appointmentId === item.appointmentId ? picking : null;
            const useCatalog = (options?.length ?? 0) > 0;
            const canConfirm = useCatalog ? definitionId !== "" : freeText.trim() !== "";
            const name = <span className="min-w-0 break-words text-sm font-medium text-ink">{item.patientName}</span>;
            return (
              <li key={item.appointmentId} className="px-4 py-3" data-testid={`outcome-row-${item.appointmentId}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {renderPatientLink ? renderPatientLink(item, name) : name}
                    {item.journeyType && <Badge tone="neutral">{item.journeyType}</Badge>}
                  </span>
                  <span className="text-xs tabular-nums text-ink-2">{fmtTime(item.time)}</span>
                </div>
                <p className="mb-1.5 mt-2 text-[11px] font-medium uppercase tracking-wide text-ink-2">Record consultation outcome</p>
                <div className="flex flex-wrap gap-1.5">
                  {ACTIONS.map((a) => (
                    <Button
                      key={a.outcome}
                      size="sm"
                      disabled={isPending}
                      aria-pressed={picker?.outcome === a.outcome}
                      onClick={() => {
                        if (options && OUTCOMES_WITH_TREATMENT.includes(a.outcome)) {
                          setPicking({ appointmentId: item.appointmentId, outcome: a.outcome });
                          setDefinitionId("");
                          setFreeText("");
                        } else {
                          closePicker();
                          onRecord(item.appointmentId, a.outcome);
                        }
                      }}
                      className={picker?.outcome === a.outcome ? "border-primary-500! bg-primary-50! text-primary-800!" : ""}
                      data-testid={`outcome-${a.outcome}-${item.appointmentId}`}
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
                {picker && (
                  <div className="mt-2.5 rounded-control border border-line bg-surface-info p-2.5" data-testid={`treatment-picker-${item.appointmentId}`}>
                    <p className="mb-1.5 text-xs text-ink-2">
                      {OUTCOME_LABEL[picker.outcome]}
                      {item.journeyType ? ` for ${item.journeyType}` : ""}: which treatment?
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {useCatalog ? (
                        <FilterSelect
                          aria-label="Treatment"
                          value={definitionId}
                          onChange={(e) => setDefinitionId(e.target.value)}
                          className="min-w-[10rem] flex-1"
                          data-testid={`treatment-select-${item.appointmentId}`}
                        >
                          <option value="">Select a treatment</option>
                          {options!.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))}
                        </FilterSelect>
                      ) : (
                        <input
                          aria-label="Treatment"
                          value={freeText}
                          onChange={(e) => setFreeText(e.target.value)}
                          placeholder="Treatment"
                          className={textFieldClass}
                          data-testid={`treatment-text-${item.appointmentId}`}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isPending || !canConfirm}
                        onClick={() => {
                          onRecord(item.appointmentId, picker.outcome, useCatalog ? { treatmentDefinitionId: definitionId } : { treatmentLabel: freeText.trim() });
                          closePicker();
                        }}
                        data-testid={`treatment-confirm-${item.appointmentId}`}
                      >
                        Record
                      </Button>
                      <Button size="sm" onClick={closePicker} data-testid={`treatment-cancel-${item.appointmentId}`}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
