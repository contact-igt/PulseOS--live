"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Mic, Play } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Badge, Button, ErrorState, Skeleton, fmtCallDuration, fmtSmartDateTime } from "@pulseos/ui";
import type { TelephonyCallDetail, TelephonyCallRecord } from "@pulseos/types";

// Recent calls on a telephony integration (CCS IVR, Runo). Two views, same sheet: a scannable list, and one call opened.
// Status is always words (never colour alone). Nothing here holds a provider URL: playback asks PulseOS, which authorizes.

const STATUS_LABEL: Record<string, string> = { completed: "Answered", missed: "Missed", no_answer: "No answer", busy: "Busy", failed: "Failed" };
const STATUS_TONE: Record<string, "success" | "danger" | "neutral"> = { completed: "success", missed: "danger" };
const DIRECTION_LABEL = { inbound: "Incoming", outbound: "Outgoing" } as const;

function Handler({ c }: { c: Pick<TelephonyCallRecord, "handledByName" | "agentName"> }) {
  if (c.handledByName) return <span>Handled by {c.handledByName}</span>;
  if (c.agentName) return <span>Agent {c.agentName} (not mapped)</span>;
  return null;
}

export function RecentCalls({ calls, onOpen }: { calls: TelephonyCallRecord[]; onOpen: (callId: string) => void }) {
  if (calls.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line bg-surface p-3" data-testid="recent-calls-empty">
        <p className="text-xs font-medium text-ink">No calls received yet</p>
        <p className="mt-1 text-[11px] text-ink-3">Calls on your IVR lines appear here as soon as the provider reports them. To check the flow end to end now, use Send test call event: it is simulated, marked as a test, and does not count as a real call report.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-surface text-xs" data-testid="recent-telephony-calls">
      {calls.map((c) => {
        const details = [c.startedAt ? fmtSmartDateTime(c.startedAt) : null, c.durationSeconds ? fmtCallDuration(c.durationSeconds) : null, c.sourceLabel].filter(Boolean);
        return (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)} className="flex min-h-11 w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500" data-testid={`call-row-${c.id}`}>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
                {c.isTest && <Badge tone="primary">Test</Badge>}
                <span className="text-ink-3">{DIRECTION_LABEL[c.direction]}</span>
                <span className="font-medium text-ink">{c.patientName ?? c.phone}</span>
                {c.patientName && <span className="text-[11px] text-ink-3">{c.phone}</span>}
                {c.hasRecording && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-2">
                    <Mic size={12} aria-hidden="true" /> Recording
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
                {details.map((x, i) => (
                  <span key={i}>{x}</span>
                ))}
                <Handler c={c} />
                {c.nextAction && <span className="font-medium text-warning-700">Callback due {fmtSmartDateTime(c.nextAction.dueAt)}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5 break-words text-ink">{children}</dd>
    </div>
  );
}

export function CallDetailPanel({ integrationKey, callId, onBack, canPlay, canDownload }: { integrationKey: string; callId: string; onBack: () => void; canPlay: boolean; canDownload: boolean }) {
  const q = useQuery({ queryKey: ["integration-call", integrationKey, callId], queryFn: () => api.integrationCall(integrationKey, callId), retry: false });
  const [playing, setPlaying] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const c: TelephonyCallDetail | undefined = q.data;
  return (
    <div className="space-y-3 text-sm">
      <Button size="sm" variant="ghost" onClick={onBack} className="min-h-11 sm:min-h-0">
        <ArrowLeft size={13} aria-hidden="true" /> All calls
      </Button>
      {q.isLoading && <Skeleton className="h-40" />}
      {q.isError && <ErrorState message="Could not load this call. It may have been removed, or you may not have access." />}
      {c && (
        <div className="space-y-3 rounded-card border border-line bg-surface p-3" data-testid="call-detail">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
            {c.isTest && <Badge tone="primary">Test</Badge>}
            <span className="text-xs text-ink-3">{DIRECTION_LABEL[c.direction]} call{c.isTest ? ". Simulated from Send test call event." : ""}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <Row label="Caller">
              <span className="font-medium">{c.patientName ?? c.phone}</span>
              {c.patientName && <span className="block text-ink-3">{c.phone}</span>}
            </Row>
            <Row label="When">{c.startedAt ? fmtSmartDateTime(c.startedAt) : "—"}</Row>
            <Row label="Duration">{fmtCallDuration(c.durationSeconds)}</Row>
            <Row label="Handled by">
              {c.handledByName ?? (c.agentName ? `${c.agentName} (not mapped to a team member)` : "—")}
              {c.handledByName && c.agentName && <span className="block text-ink-3">Provider agent: {c.agentName}</span>}
            </Row>
            {(c.calledLine || c.lineLabel) && (
              <Row label="IVR line">
                {c.lineLabel ?? c.calledLine}
                {c.lineLabel && c.calledLine && <span className="block text-ink-3">{c.calledLine}</span>}
              </Row>
            )}
            {c.callGroup && <Row label="Call group">{c.callGroup}</Row>}
            {c.ivrSelection && <Row label="IVR selection">{c.ivrSelection}</Row>}
            <Row label="Source">
              {c.sourceLabel ?? "—"}
              {c.sourceDetail && <span className="block text-ink-3">{c.sourceDetail}</span>}
            </Row>
            {c.circle && (
              <Row label="Telecom circle">
                {c.circle}
                <span className="block text-ink-3">Approximate, from the phone network. Not the patient&apos;s location.</span>
              </Row>
            )}
            <Row label="Provider">
              {c.providerLabel ?? "—"}
              {c.providerCallId && <span className="block font-mono text-[11px] text-ink-3">{c.providerCallId}</span>}
              {c.providerStatus && <span className="block text-ink-3">Reported as: {c.providerStatus}</span>}
            </Row>
            {c.nextAction && <Row label="Next action">Callback due {fmtSmartDateTime(c.nextAction.dueAt)}</Row>}
          </dl>

          {c.hasRecording && (
            <div className="space-y-1.5 border-t border-line/60 pt-3">
              {canPlay ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {!audioFailed && (
                    <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-0" onClick={() => setPlaying((p) => !p)}>
                      <Play size={13} aria-hidden="true" /> {playing ? "Hide player" : "Play recording"}
                    </Button>
                  )}
                  {canDownload && (
                    <a href={api.callRecordingUrl(c.id, { download: true })} className="inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-xs font-medium text-primary-700 hover:underline sm:min-h-8">
                      <Download size={13} aria-hidden="true" /> Download
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-xs text-ink-2">Recording on file. Your role cannot play recordings.</p>
              )}
              {audioFailed && <p className="text-xs text-ink-2">Recording unavailable. The provider may have removed it.</p>}
              {canPlay && playing && !audioFailed && (
                // The browser asks PulseOS for the audio; PulseOS checks tenant and permission, then streams it.
                <audio controls autoPlay preload="none" src={api.callRecordingUrl(c.id)} onError={() => setAudioFailed(true)} className="h-10 w-full" />
              )}
            </div>
          )}

          {c.journeyId && (
            <a href={`/journeys/${c.journeyId}`} className="inline-flex min-h-11 items-center text-xs font-medium text-primary-700 hover:underline sm:min-h-0">
              Open journey
            </a>
          )}
        </div>
      )}
    </div>
  );
}
