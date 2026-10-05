"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@pulseos/api-client";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterBar, FilterSelect, OverflowMenu, SectionHeading, Skeleton, useDialogFocus, relativeTime, fmtDate, fmtDateTime, fmtSmartDateTime, JOURNEY_STAGE_LABEL } from "@pulseos/ui";
import { useQuickCreate } from "../../../components/shell/QuickCreateProvider";
import { withFrom } from "@/components/shell/BackLink";
import { instantToWallTime, wallTimeToInstant } from "@/lib/hospitalTime";
import { useHospitalTimeZone } from "@/lib/useHospitalTimeZone";
import type { ConversationAutomationMode, ConversationAutomationPreference, ConversationChannel, ConversationDetail, OwnershipState } from "@pulseos/types";
import { ArrowLeft, CalendarPlus, ListPlus, Mail, MessageCircle, MessageSquareText, PanelRight, Phone, Search, User, Users as UsersIcon, X } from "lucide-react";

const CHANNEL_ICON: Record<ConversationChannel, typeof Mail> = {
  WHATSAPP: MessageCircle,
  CALL: Phone,
  SMS: MessageSquareText,
  EMAIL: Mail,
  INTERNAL: UsersIcon,
};

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  WHATSAPP: "WhatsApp",
  CALL: "Call",
  SMS: "SMS",
  EMAIL: "Email",
  INTERNAL: "Internal",
};

const OWNERSHIP_LABEL: Record<OwnershipState, string> = {
  AI_ACTIVE: "AI active",
  HUMAN_REQUIRED: "Needs attention",
  HUMAN_ASSIGNED: "Assigned",
  HUMAN_ACTIVE: "You're handling this",
  AI_RESUME_PENDING: "Returning to AI",
  CLOSED: "Closed",
};

const OWNERSHIP_TONE: Record<OwnershipState, "neutral" | "warning" | "danger" | "primary"> = {
  AI_ACTIVE: "neutral",
  HUMAN_REQUIRED: "warning",
  HUMAN_ASSIGNED: "neutral",
  HUMAN_ACTIVE: "primary",
  AI_RESUME_PENDING: "neutral",
  CLOSED: "neutral",
};

const AUTOMATION_MODE_LABEL: Record<ConversationAutomationMode, string> = {
  manual: "Manual only",
  ai_when_available: "AI when available",
  ai_scheduled: "AI scheduled",
};

// One primary ownership action per state, per the functional-hardening pass:
// a single clear next step instead of 3-4 always-visible buttons. Assign,
// Close and other rarer actions live in the "More" menu instead. CLOSED has
// no primary action — there is nothing further to do with a closed thread.
const PRIMARY_ACTION_LABEL: Partial<Record<OwnershipState, string>> = {
  HUMAN_REQUIRED: "Claim",
  HUMAN_ASSIGNED: "Claim",
  AI_ACTIVE: "Take over",
  AI_RESUME_PENDING: "Take over",
  HUMAN_ACTIVE: "Return to AI",
};


export default function InboxPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const quickCreate = useQuickCreate();
  const [channel, setChannel] = useState<ConversationChannel | "">("");
  const [ownershipState, setOwnershipState] = useState<OwnershipState | "">("");
  const [communicationEndpointId, setCommunicationEndpointId] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [assignTarget, setAssignTarget] = useState("");
  // "Assign to…" is a rare action tucked in the ownership More menu — this
  // reveals the picker row it needs without giving it standing header space.
  const [assigning, setAssigning] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [schedulingAi, setSchedulingAi] = useState(false);
  // Below `md` the list and thread are two full-width screens, not two
  // squeezed columns — this tracks which one is showing.
  const [mobileView, setMobileView] = useState<"list" | "thread">("list");
  // Patient Context is a persistent 3rd column only at very wide viewports
  // (2xl+); everywhere narrower it's a toggleable drawer over the thread —
  // this is what actually fixes the "3 columns squeeze the thread" bug:
  // reclaiming the context column's ~300px instead of shrinking it.
  const [contextOpen, setContextOpen] = useState(false);

  const conversations = useQuery({
    queryKey: ["conversations", channel, ownershipState, communicationEndpointId, search],
    queryFn: () =>
      api.conversations({
        channel: channel || undefined,
        ownershipState: ownershipState || undefined,
        communicationEndpointId: communicationEndpointId || undefined,
        search: search || undefined,
      }),
  });

  // Populates the "line" filter — which hospital phone/WhatsApp line a
  // conversation came in on. Tenant-wide flat list (no connectorId arg),
  // not the per-connector one used on the Integrations page.
  const communicationEndpoints = useQuery({ queryKey: ["communication-endpoints"], queryFn: () => api.communicationEndpoints() });

  const effectiveSelectedId = selectedId ?? conversations.data?.[0]?.id ?? null;

  const detail = useQuery({
    queryKey: ["conversation", effectiveSelectedId],
    queryFn: () => api.conversation(effectiveSelectedId!),
    enabled: !!effectiveSelectedId,
  });

  const lookups = useQuery({ queryKey: ["lookups"], queryFn: api.lookups });

  const selectedConversation = useMemo(
    () => conversations.data?.find((c) => c.id === effectiveSelectedId) ?? null,
    [conversations.data, effectiveSelectedId],
  );

  function selectConversation(id: string) {
    setSelectedId(id);
    setMobileView("thread");
  }

  const contextDialogRef = useDialogFocus<HTMLDivElement>(contextOpen, () => setContextOpen(false));

  // Reset per-conversation transient UI (assign picker, close confirmation) when the
  // selected conversation changes — adjusted during render rather than in an effect,
  // per React's guidance for state resets keyed off a changing value.
  const [resetForId, setResetForId] = useState(effectiveSelectedId);
  if (effectiveSelectedId !== resetForId) {
    setResetForId(effectiveSelectedId);
    setAssigning(false);
    setAssignTarget("");
    setConfirmingClose(false);
    setSchedulingAi(false);
  }

  const automation = useQuery({
    queryKey: ["conversation-automation", effectiveSelectedId],
    queryFn: () => api.conversationAutomation(effectiveSelectedId!),
    enabled: !!effectiveSelectedId,
  });

  function refreshAfterAction() {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", effectiveSelectedId] });
  }

  async function handleClaim() {
    if (!effectiveSelectedId) return;
    await api.claimConversation(effectiveSelectedId);
    refreshAfterAction();
  }

  async function handleReturnToAi() {
    if (!effectiveSelectedId) return;
    await api.returnConversationToAi(effectiveSelectedId);
    refreshAfterAction();
  }

  async function handleClose() {
    if (!effectiveSelectedId) return;
    await api.closeConversation(effectiveSelectedId);
    setConfirmingClose(false);
    refreshAfterAction();
  }

  async function handleAssign() {
    if (!effectiveSelectedId || !assignTarget) return;
    await api.assignConversation(effectiveSelectedId, assignTarget);
    setAssignTarget("");
    setAssigning(false);
    refreshAfterAction();
  }

  async function handleSend() {
    if (!effectiveSelectedId || !draft.trim()) return;
    await api.sendConversationMessage(effectiveSelectedId, draft.trim());
    setDraft("");
    refreshAfterAction();
  }

  function openBookAppointment() {
    if (!detail.data?.patientContext || !selectedConversation) return;
    quickCreate.openNewAppointment({ patient: { id: detail.data.patientContext.patientId, name: selectedConversation.patientName, phone: "" } });
  }

  function openCreateTask() {
    if (!detail.data?.patientContext || !selectedConversation) return;
    quickCreate.openAddTask({ patient: { id: detail.data.patientContext.patientId, name: selectedConversation.patientName, phone: "" } });
  }

  function goToProfile() {
    if (!detail.data?.patientContext) return;
    router.push(withFrom(`/patients/${detail.data.patientContext.patientId}`, "inbox"));
  }

  return (
    <div className="flex h-full gap-4" data-testid="inbox-page">
      {/* Conversation list — full width on its own screen below md, a fixed-width column alongside the thread at md+.
          Solid white panel: the list scrolls, so no backdrop blur behind it. */}
      <aside
        className={`${mobileView === "thread" ? "hidden" : "flex"} w-full flex-shrink-0 flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel md:flex md:w-72 xl:w-80`}
      >
        <div className="space-y-2 border-b border-line bg-surface-muted p-3">
          <label className="glass-control relative flex h-8 items-center rounded-control">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-neutral-500" aria-hidden="true" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search patient…"
              aria-label="Search conversations by patient"
              className="h-full w-full bg-transparent pl-8 pr-2.5 text-xs text-ink outline-none placeholder:text-neutral-500"
            />
          </label>
          <FilterBar className="gap-1.5">
            <FilterSelect className="sm:flex-1!" value={channel} onChange={(e) => setChannel(e.target.value as ConversationChannel | "")} aria-label="Channel">
              <option value="">All channels</option>
              {(Object.keys(CHANNEL_LABEL) as ConversationChannel[]).map((c) => (
                <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
              ))}
            </FilterSelect>
            <FilterSelect className="sm:flex-1!" value={ownershipState} onChange={(e) => setOwnershipState(e.target.value as OwnershipState | "")} aria-label="Conversation state">
              <option value="">All states</option>
              {(Object.keys(OWNERSHIP_LABEL) as OwnershipState[]).map((s) => (
                <option key={s} value={s}>{OWNERSHIP_LABEL[s]}</option>
              ))}
            </FilterSelect>
            {communicationEndpoints.data && communicationEndpoints.data.length > 0 && (
              <FilterSelect
                value={communicationEndpointId}
                onChange={(e) => setCommunicationEndpointId(e.target.value)}
                className="w-full"
                aria-label="Line"
                data-testid="endpoint-filter-select"
              >
                <option value="">All lines</option>
                {communicationEndpoints.data.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>{endpoint.displayLabel}</option>
                ))}
              </FilterSelect>
            )}
          </FilterBar>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.isLoading && (
            <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          )}
          {conversations.isError && <div className="p-3"><ErrorState message="Could not load conversations." /></div>}
          {conversations.data && conversations.data.length === 0 && <div className="p-3"><EmptyState message="No conversations match this filter." /></div>}
          {conversations.data?.map((c) => {
            const Icon = CHANNEL_ICON[c.channel];
            const active = c.id === effectiveSelectedId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => selectConversation(c.id)}
                data-testid={`conversation-${c.id}`}
                aria-current={active ? "true" : undefined}
                className={`flex w-full flex-col gap-1 border-b border-line border-l-2 px-3 py-2.5 text-left transition-colors hover:bg-primary-50/60 ${active ? "border-l-primary-600 bg-primary-50" : "border-l-transparent"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-ink">
                    <Icon size={14} className="shrink-0 text-primary-600" aria-label={CHANNEL_LABEL[c.channel]} />
                    <span className="truncate">{c.patientName}</span>
                  </span>
                  <span className="whitespace-nowrap text-[10px] text-ink-2">{relativeTime(c.lastMessageAt)}</span>
                </div>
                <p className="truncate text-xs text-ink-2">{c.lastMessage ?? "No messages yet"}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Badge tone={OWNERSHIP_TONE[c.ownershipState]}>{OWNERSHIP_LABEL[c.ownershipState]}</Badge>
                    {c.endpointLabel && (
                      <span className="truncate text-[11px] text-ink-2" data-testid={`conversation-row-line-${c.id}`}>
                        {c.endpointLabel}
                      </span>
                    )}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="min-w-[18px] rounded-full bg-primary-600 px-1.5 text-center text-[10px] font-semibold text-white" aria-label={`${c.unreadCount} unread`}>
                      {c.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Thread — the primary surface. Never shares its width with Patient Context below 2xl. */}
      <section className={`${mobileView === "list" ? "hidden" : "flex"} min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface shadow-panel md:flex`}>
        {!selectedConversation && <EmptyState message="Select a conversation to view messages." />}
        {selectedConversation && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button type="button" onClick={() => setMobileView("list")} className="shrink-0 rounded-control p-1 text-neutral-600 hover:bg-primary-50 md:hidden" aria-label="Back to conversations">
                  <ArrowLeft size={18} />
                </button>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{selectedConversation.patientName}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                    {CHANNEL_LABEL[selectedConversation.channel]}
                    <Badge tone={OWNERSHIP_TONE[selectedConversation.ownershipState]}>{OWNERSHIP_LABEL[selectedConversation.ownershipState]}</Badge>
                    {automation.data && automation.data.mode !== "manual" && (
                      <span className="rounded-chip border border-line px-1.5 py-0.5 text-[10px] font-medium text-ink-2" data-testid="automation-mode-indicator">
                        {AUTOMATION_MODE_LABEL[automation.data.mode]}
                      </span>
                    )}
                    {selectedConversation.endpointLabel && <span data-testid="conversation-endpoint-label">· {selectedConversation.endpointLabel}</span>}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedConversation.ownershipState !== "CLOSED" && (() => {
                  const label = PRIMARY_ACTION_LABEL[selectedConversation.ownershipState];
                  if (!label) return null;
                  const onClick = selectedConversation.ownershipState === "HUMAN_ACTIVE" ? handleReturnToAi : handleClaim;
                  const testId = selectedConversation.ownershipState === "HUMAN_ACTIVE" ? "return-to-ai" : label === "Take over" ? "take-over-conversation" : "claim-conversation";
                  return (
                    <Button variant="primary" size="sm" onClick={onClick} data-testid={testId}>
                      {label}
                    </Button>
                  );
                })()}
                {selectedConversation.ownershipState !== "CLOSED" && (
                  <OverflowMenu
                    testId="conversation-more-actions"
                    items={[
                      { key: "assign", label: "Assign Team Member", onClick: () => setAssigning(true) },
                      { key: "schedule-ai", label: "Schedule AI…", onClick: () => setSchedulingAi(true) },
                      { key: "close", label: "Close conversation", danger: true, onClick: () => setConfirmingClose(true) },
                    ]}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setContextOpen(true)}
                  className="rounded-control p-1.5 text-neutral-600 hover:bg-primary-50 2xl:hidden"
                  title="Patient context"
                  aria-label="Show patient context"
                  data-testid="open-patient-context"
                >
                  <PanelRight size={16} />
                </button>
              </div>
            </div>

            {assigning && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-muted px-4 py-2">
                <span className="text-xs text-ink-2">Assign Team Member</span>
                <select
                  value={assignTarget}
                  onChange={(e) => setAssignTarget(e.target.value)}
                  className="h-8 rounded-control border border-line-strong bg-surface px-2 text-xs text-ink"
                  autoFocus
                  data-testid="assign-target-select"
                >
                  <option value="">Choose a person…</option>
                  {lookups.data?.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <Button variant="primary" size="sm" onClick={handleAssign} disabled={!assignTarget} data-testid="confirm-assign">
                  Assign
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAssigning(false);
                    setAssignTarget("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

            <ConfirmDialog
              open={confirmingClose}
              title="Close this conversation?"
              description="No further messages will send from PulseOS on this thread, and it moves out of every active queue. You can still view its history, but reopening a closed conversation isn't currently supported — only close it once the patient's request is fully resolved."
              confirmLabel="Close conversation"
              onConfirm={handleClose}
              onCancel={() => setConfirmingClose(false)}
            />

            {schedulingAi && effectiveSelectedId && (
              <AiSchedulePanel
                conversationId={effectiveSelectedId}
                current={automation.data}
                onSaved={() => {
                  setSchedulingAi(false);
                  queryClient.invalidateQueries({ queryKey: ["conversation-automation", effectiveSelectedId] });
                }}
                onCancel={() => setSchedulingAi(false)}
              />
            )}

            {/* Message list: plain scrolling surface (no blur, no gradient). Sender is named on every bubble and by alignment, never by colour alone. */}
            <div className="flex-1 space-y-3 overflow-y-auto bg-surface-muted p-4" data-testid="message-list">
              {detail.isLoading && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>}
              {detail.data?.messages.map((m) =>
                m.senderType === "system" ? (
                  <p key={m.id} className="text-center text-[11px] italic text-ink-2">{m.body}</p>
                ) : (
                  <div key={m.id} className={`flex ${m.senderType === "patient" ? "justify-start" : "justify-end"}`}>
                    <div
                      className={`max-w-[75%] rounded-card border px-3 py-2 text-xs text-ink ${
                        m.senderType === "patient"
                          ? "border-line bg-surface"
                          : m.senderType === "ai"
                            ? "border-primary-200 bg-surface-info"
                            : "border-primary-200 bg-primary-100"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className="mt-1 text-[10px] text-ink-2">
                        {m.senderType === "staff" ? m.senderName ?? "Staff" : m.senderType === "ai" ? "AI Assistant" : "Patient"} · {relativeTime(m.sentAt)}
                      </p>
                    </div>
                  </div>
                ),
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-center gap-2 border-t border-line px-4 py-3"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={selectedConversation.ownershipState === "CLOSED" ? "This conversation is closed" : "Type a message…"}
                aria-label="Message"
                disabled={selectedConversation.ownershipState === "CLOSED"}
                className="h-9 flex-1 rounded-control border border-line-strong bg-surface px-3 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500 disabled:bg-surface-muted"
              />
              <Button type="submit" variant="primary" disabled={selectedConversation.ownershipState === "CLOSED" || !draft.trim()}>
                Send
              </Button>
            </form>
          </>
        )}
      </section>

      {/* Patient Context — a real 3rd column only at very wide viewports. */}
      <Card tone="info" className="hidden w-72 flex-shrink-0 overflow-y-auto p-3 2xl:block xl:w-80">
        <PatientContextPanel detail={detail.data} onBook={openBookAppointment} onTask={openCreateTask} onProfile={goToProfile} />
      </Card>

      {/* Same content as a slide-over drawer everywhere narrower than 2xl. */}
      {contextOpen && (
        <div className="fixed inset-0 z-(--z-sheet) flex justify-end 2xl:hidden" role="dialog" aria-modal="true" aria-label="Patient context">
          <button type="button" aria-label="Close" onClick={() => setContextOpen(false)} className="absolute inset-0 bg-slate-900/30 transition-opacity duration-200 motion-reduce:transition-none" />
          <div
            ref={contextDialogRef}
            tabIndex={-1}
            className="relative flex h-full w-full max-w-xs flex-col overflow-y-auto border-l border-line bg-surface-info p-3 shadow-xl transition-transform duration-200 motion-reduce:transition-none focus:outline-none"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">Patient context</span>
              <button type="button" onClick={() => setContextOpen(false)} aria-label="Close patient context" className="rounded-control p-1 text-neutral-600 hover:bg-white/70 hover:text-ink" data-testid="close-patient-context">
                <X size={16} />
              </button>
            </div>
            <PatientContextPanel detail={detail.data} onBook={openBookAppointment} onTask={openCreateTask} onProfile={goToProfile} hideTitle />
          </div>
        </div>
      )}
    </div>
  );
}

// datetime-local inputs hold "YYYY-MM-DDTHH:mm" — here always the HOSPITAL's wall time, never the browser's.
function isoToLocalInputValue(iso: string, timeZone: string): string {
  const { date, time } = instantToWallTime(new Date(iso), timeZone);
  return `${date}T${time}`;
}

function localInputValueToIso(value: string, timeZone: string): string | undefined {
  const [date, time] = value.split("T");
  return (date && time ? wallTimeToInstant(date, time.slice(0, 5), timeZone) : null)?.toISOString();
}

function AiSchedulePanel({
  conversationId,
  current,
  onSaved,
  onCancel,
}: {
  conversationId: string;
  current: ConversationAutomationPreference | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const timeZone = useHospitalTimeZone();
  const [mode, setMode] = useState<ConversationAutomationMode>(current?.mode ?? "manual");
  const [start, setStart] = useState(current?.scheduledStart ? isoToLocalInputValue(current.scheduledStart, timeZone) : "");
  const [end, setEnd] = useState(current?.scheduledEnd ? isoToLocalInputValue(current.scheduledEnd, timeZone) : "");
  const [timezone, setTimezone] = useState(current?.timezone ?? timeZone);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    if (mode === "ai_scheduled" && (!start || !end)) {
      setError("Choose a start and end time for the AI window.");
      return;
    }
    setSaving(true);
    try {
      await api.setConversationAutomation(conversationId, {
        mode,
        scheduledStart: mode === "ai_scheduled" ? localInputValueToIso(start, timeZone) : undefined,
        scheduledEnd: mode === "ai_scheduled" ? localInputValueToIso(end, timeZone) : undefined,
        timezone: mode === "ai_scheduled" ? timezone : undefined,
      });
      onSaved();
    } catch {
      setError("Could not save this preference — please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border-b border-line bg-surface-muted px-4 py-3" data-testid="ai-schedule-panel">
      <div>
        <p className="text-xs font-semibold text-ink">AI scheduling preference</p>
        <p className="text-[11px] text-ink-2">
          Configuration only — PulseOS has no live AI agent yet to act on this. Saving just records what should happen once one exists.
        </p>
      </div>
      <div className="glass-control inline-flex rounded-control p-0.5" role="radiogroup" aria-label="AI scheduling preference" data-testid="automation-mode-select">
        {(["manual", "ai_when_available", "ai_scheduled"] as ConversationAutomationMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${mode === m ? "bg-white text-primary-800 shadow-panel" : "text-ink-2 hover:bg-white/60 hover:text-ink"}`}
            data-testid={`automation-mode-${m}`}
          >
            {AUTOMATION_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      {current?.mode === "ai_scheduled" && current.scheduledStart && current.scheduledEnd && (
        <p className="text-[11px] text-ink-2">
          Currently: {fmtSmartDateTime(current.scheduledStart)} → {fmtSmartDateTime(current.scheduledEnd)} ({current.timezone})
        </p>
      )}
      {mode === "ai_scheduled" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-ink-2">
            Start
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 rounded-control border border-line-strong bg-surface px-1.5 text-xs text-ink" data-testid="automation-start-input" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-ink-2">
            End
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 rounded-control border border-line-strong bg-surface px-1.5 text-xs text-ink" data-testid="automation-end-input" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-ink-2">
            Timezone
            <input type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="h-8 w-32 rounded-control border border-line-strong bg-surface px-1.5 text-xs text-ink" data-testid="automation-timezone-input" />
          </label>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-danger-700">{error}</p>}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={save} disabled={saving} data-testid="save-automation">
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {mode !== "manual" && (
          <span className="text-[10px] text-ink-2">Automated replies require the AI runtime to be active.</span>
        )}
      </div>
    </div>
  );
}

function PatientContextPanel({
  detail,
  onBook,
  onTask,
  onProfile,
  hideTitle = false,
}: {
  detail: ConversationDetail | undefined;
  onBook: () => void;
  onTask: () => void;
  onProfile: () => void;
  hideTitle?: boolean;
}) {
  return (
    <>
      {!hideTitle && <SectionHeading title="Patient context" />}
      {!detail?.patientContext && <p className="text-xs text-ink-2">No active journey for this patient.</p>}
      {detail?.patientContext && (
        <dl className="space-y-2 text-xs">
          <Row label="Journey" value={detail.patientContext.journeyType} />
          <Row label="Stage" value={detail.patientContext.stage ? (JOURNEY_STAGE_LABEL[detail.patientContext.stage] ?? detail.patientContext.stage) : null} />
          <Row label="Assigned Team Member" value={detail.patientContext.ownerName} />
          <Row label="Next appointment" value={detail.patientContext.appointmentTime ? fmtDateTime(detail.patientContext.appointmentTime) : null} />
          <Row label="Next action due" value={detail.patientContext.nextActionDueAt ? fmtDate(detail.patientContext.nextActionDueAt) : null} />
          <Row label="Last interaction" value={detail.patientContext.lastInteractionAt ? relativeTime(detail.patientContext.lastInteractionAt) : null} />
        </dl>
      )}

      {detail?.patientContext && (
        <div className="mt-4 border-t border-line pt-3">
          <SectionHeading title="Quick Actions" />
          <div className="space-y-1">
            <QuickActionButton icon={CalendarPlus} label="Book Appointment" onClick={onBook} />
            <QuickActionButton icon={ListPlus} label="Create Task" onClick={onTask} />
            <QuickActionButton icon={User} label="View Full Profile" onClick={onProfile} />
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line pb-1.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right font-medium text-ink">{value ?? "—"}</dd>
    </div>
  );
}

function QuickActionButton({ icon: Icon, label, onClick }: { icon: typeof User; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-ink transition hover:bg-white/80"
    >
      <Icon size={14} className="text-primary-600" />
      {label}
    </button>
  );
}
