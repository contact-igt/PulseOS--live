"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, MessageSquarePlus, Play } from "lucide-react";
import { api } from "@pulseos/api-client";
import { Badge, Button, fmtCallDuration, fmtSmartDateTime } from "@pulseos/ui";
import type { CallVm, SummaryMode } from "@pulseos/types";

export interface CallCardPermissions {
  canLog: boolean;
  canPlay: boolean;
  canDownload: boolean;
  canTranscript: boolean;
}

/** 44px touch targets on a phone, compact on desktop. */
const TOUCH = "min-h-11 sm:min-h-0";

const SUMMARY_LABEL: Record<SummaryMode, string> = {
  AI: "AI summary",
  PROVIDER: "Summary from your phone provider",
  FIXTURE: "Demo summary — not AI",
  MANUAL: "Summary",
};

function Transcript({ callId }: { callId: string }) {
  const transcript = useQuery({ queryKey: ["call-transcript", callId], queryFn: () => api.callTranscript(callId), retry: false });
  if (transcript.isLoading) return <p className="text-xs text-ink-2">Loading transcript…</p>;
  if (transcript.isError || !transcript.data?.text) return <p className="text-xs text-ink-2">Transcript unavailable.</p>;
  return (
    <div className="rounded-control border border-line bg-surface p-3" data-testid={`call-transcript-text-${callId}`}>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
        Transcript{transcript.data.mode === "FIXTURE" ? " · demo, not a real transcription" : transcript.data.mode === "PROVIDER" ? " · from your phone provider" : ""}
      </p>
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-ink">{transcript.data.text}</p>
    </div>
  );
}

/**
 * One call on the Timeline — IVR or logged by hand, the same card. Three things are always visually distinct:
 * what PulseOS derived (the AI / demo summary, labelled by how it was made), what a person wrote (Staff feedback),
 * and the raw call (recording, transcript behind a toggle). Controls only appear for roles that hold the permission;
 * the server enforces it regardless.
 */
export function CallCard({ call, perms, onAddFeedback }: { call: CallVm; perms: CallCardPermissions; onAddFeedback: (call: CallVm) => void }) {
  const queryClient = useQueryClient();
  const [playing, setPlaying] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const intel = call.intelligence;
  const notConnectedLabel = call.direction === "inbound" ? "Missed" : "No answer";
  const duration = fmtCallDuration(call.durationSeconds);

  async function retry() {
    setRetrying(true);
    try {
      await api.retryCallIntelligence(call.id);
      queryClient.invalidateQueries({ queryKey: ["journey"] });
      queryClient.invalidateQueries({ queryKey: ["patient360"] });
    } catch {
      /* a refused retry (nothing failed any more) just leaves the card as it is */
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-card border border-line bg-surface p-3" data-testid={`call-card-${call.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{call.direction === "inbound" ? "Incoming" : "Outgoing"}</Badge>
        <Badge tone="neutral">{call.origin === "IVR" ? "IVR" : "Logged by staff"}</Badge>
        <Badge tone={call.connected ? "success" : "warning"}>{call.connected ? "Connected" : notConnectedLabel}</Badge>
        <span className="text-xs text-ink-2">
          {[duration || null, call.agentName ? `${call.origin === "IVR" ? "Agent" : "Logged by"} ${call.agentName}` : null].filter(Boolean).join(" · ")}
        </span>
      </div>

      {intel?.summary && (
        <div className="rounded-control bg-surface-info px-3 py-2" data-testid={`call-summary-${call.id}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{SUMMARY_LABEL[intel.summary.mode]}</p>
          <p className="mt-0.5 break-words text-xs leading-5 text-ink">{intel.summary.text}</p>
          {intel.summary.agreedAction && <p className="mt-1 break-words text-xs text-ink-2">Agreed: {intel.summary.agreedAction}</p>}
          {intel.summary.nextAction && <p className="break-words text-xs text-ink-2">Next action: {intel.summary.nextAction}</p>}
        </div>
      )}
      {intel && !intel.summary && (
        <p className="text-xs text-ink-2" data-testid={`call-intel-status-${call.id}`}>
          {intel.failed
            ? "Transcript or summary couldn't be created."
            : intel.transcriptStatus === "NOT_CONFIGURED"
              ? "Transcription not configured."
              : intel.transcriptStatus === "PENDING" || intel.transcriptStatus === "PROCESSING"
                ? "Transcript processing…"
                : intel.summaryStatus === "PENDING" || intel.summaryStatus === "PROCESSING"
                  ? "Summary processing…"
                  : null}
          {intel.failed && perms.canTranscript && (
            <button type="button" onClick={retry} disabled={retrying} className="ml-2 font-medium text-primary-700 hover:underline disabled:opacity-60" data-testid={`call-retry-${call.id}`}>
              {retrying ? "Retrying…" : "Try again"}
            </button>
          )}
        </p>
      )}

      {call.staffFeedback && (
        <div className="border-l-2 border-primary-500 pl-3" data-testid={`call-staff-feedback-${call.id}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Staff feedback{call.staffFeedbackBy ? ` · ${call.staffFeedbackBy}` : ""}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">{call.staffFeedback}</p>
        </div>
      )}

      {(call.outcomeLabel || call.callback) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink" data-testid={`call-outcome-${call.id}`}>
          {call.outcomeLabel && <span>Outcome: <span className="font-medium">{call.outcomeLabel}</span></span>}
          {call.callback && (
            <span>
              Callback {call.callback.status === "completed" ? "done" : "created"} · due <span className="font-medium">{fmtSmartDateTime(call.callback.dueAt)}</span>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {call.hasRecording && perms.canPlay && !audioFailed && (
          <Button size="sm" variant="secondary" className={TOUCH} onClick={() => setPlaying((p) => !p)} data-testid={`call-play-${call.id}`}>
            <Play size={13} aria-hidden="true" /> {playing ? "Hide player" : "Play recording"}
          </Button>
        )}
        {call.hasRecording && perms.canDownload && (
          <a href={api.callRecordingUrl(call.id, { download: true })} className="inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-xs font-medium text-primary-700 hover:underline sm:min-h-8" data-testid={`call-download-${call.id}`}>
            <Download size={13} aria-hidden="true" /> Download
          </a>
        )}
        {intel?.hasTranscript && perms.canTranscript && (
          <Button size="sm" variant="ghost" className={TOUCH} onClick={() => setShowTranscript((s) => !s)} aria-expanded={showTranscript} data-testid={`call-transcript-toggle-${call.id}`}>
            <FileText size={13} aria-hidden="true" /> {showTranscript ? "Hide transcript" : "View transcript"}
          </Button>
        )}
        {perms.canLog && (
          <Button size="sm" variant="ghost" className={TOUCH} onClick={() => onAddFeedback(call)} data-testid={`call-feedback-add-${call.id}`}>
            <MessageSquarePlus size={13} aria-hidden="true" /> {call.staffFeedback ? "Edit feedback" : "Add feedback"}
          </Button>
        )}
      </div>

      {audioFailed && <p className="text-xs text-ink-2" data-testid={`call-recording-unavailable-${call.id}`}>Recording unavailable.</p>}
      {call.hasRecording && perms.canPlay && playing && !audioFailed && (
        // The browser asks PulseOS for the audio; PulseOS checks the permission and streams it (Range-capable, so it can seek).
        <audio controls autoPlay preload="none" src={api.callRecordingUrl(call.id)} onError={() => setAudioFailed(true)} className="h-10 w-full" data-testid={`call-audio-${call.id}`} />
      )}
      {!call.hasRecording && call.origin === "IVR" && call.connected && perms.canPlay && <p className="text-xs text-ink-2">Recording unavailable.</p>}
      {showTranscript && perms.canTranscript && <Transcript callId={call.id} />}
    </div>
  );
}
