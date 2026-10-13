"use client";

import { useLayoutEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { FileText, Film, ImagePlus, Mic, Music, Paperclip, Send, Square, Trash2, X } from "lucide-react";
import { Button } from "@pulseos/ui";
import { checkMediaFile, mediaKindForFile, type MessageAttachmentKind } from "@pulseos/types";
import { EmojiPicker } from "./EmojiPicker";
import { insertAtCursor } from "./emoji";
import { formatDuration, silentRecordingMessage, useVoiceRecorder } from "./voiceRecorder";

const ATTACH: { kind: MessageAttachmentKind; label: string; accept: string; icon: typeof FileText; tint: string }[] = [
  { kind: "image", label: "Photo", accept: "image/jpeg,image/png,image/webp,image/gif", icon: ImagePlus, tint: "text-primary-700" },
  { kind: "video", label: "Video (MP4)", accept: "video/mp4", icon: Film, tint: "text-primary-700" },
  { kind: "document", label: "Document", accept: ".pdf,.doc,.docx,.xls,.xlsx,.txt", icon: FileText, tint: "text-primary-700" },
  { kind: "audio", label: "Audio file", accept: "audio/mpeg,audio/wav,audio/webm,audio/ogg,audio/mp4,audio/aac,.mp3,.m4a,.aac,.ogg,.wav", icon: Music, tint: "text-primary-700" },
];

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The Inbox message box: text, emoji, a photo/video/document/audio file with a caption, and voice messages recorded right here.
 * It owns the draft (the page remounts it per conversation, so a draft never leaks into another patient's thread). A file is
 * checked against the same rules as the server before anything is uploaded, and shown as a chip so it can be removed first.
 */
export function Composer({
  locked,
  placeholder,
  busy,
  onSendText,
  onSendFile,
  onProblem,
}: {
  locked: boolean;
  placeholder: string;
  busy: boolean;
  /** Resolves true when the text was handled (sent, or kept as a failed message), false to keep the draft. */
  onSendText: (text: string) => Promise<boolean>;
  onSendFile: (file: File, kind: MessageAttachmentKind, caption: string) => Promise<boolean>;
  onProblem: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [staged, setStaged] = useState<{ file: File; kind: MessageAttachmentKind } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pickers = useRef<Partial<Record<MessageAttachmentKind, HTMLInputElement | null>>>({});
  // Where the caret must be after the next render: React moves it to the end whenever the text is replaced.
  const caret = useRef<number | null>(null);
  const recorder = useVoiceRecorder(onProblem);

  // Runs right after the text is committed (not on a timer), and only moves the caret: focusing the box would close the open emoji picker.
  useLayoutEffect(() => {
    if (caret.current !== null && input.current) {
      input.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [draft]);
  const disabled = locked || busy;
  const recording = recorder.state === "recording";

  function stage(file: File, kind: MessageAttachmentKind) {
    const found = mediaKindForFile({ mimeType: file.type, fileName: file.name }) ?? kind;
    const check = checkMediaFile({ kind: found, mimeType: file.type, fileName: file.name, sizeBytes: file.size });
    if (!check.ok) return onProblem(check.message);
    setStaged({ file, kind: found });
    input.current?.focus();
  }

  function addEmoji(emoji: string) {
    const el = input.current;
    const next = insertAtCursor(draft, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length, emoji);
    caret.current = next.caret;
    setDraft(next.value);
  }

  async function submit() {
    if (disabled) return;
    if (staged) {
      const done = await onSendFile(staged.file, staged.kind, draft.trim());
      if (done) {
        setStaged(null);
        setDraft("");
      }
      return;
    }
    if (!draft.trim()) return;
    if (await onSendText(draft.trim())) setDraft("");
  }

  async function sendRecording() {
    const { file, heardSound, device } = await recorder.stop();
    // A microphone that is muted, wrong, or blocked by the system can record the right length of silence. That would reach the
    // patient as an empty voice message, so it is not sent (and "no sound" is the useful explanation, with or without a file).
    if (!heardSound) return onProblem(silentRecordingMessage(device));
    if (!file) return onProblem("Nothing was recorded. Hold on a moment longer and try again.");
    const check = checkMediaFile({ kind: "audio", mimeType: file.type, fileName: file.name, sizeBytes: file.size });
    if (!check.ok) return onProblem(check.message);
    await onSendFile(file, "audio", "");
  }

  if (recording) {
    return (
      <div className="border-t border-line" data-testid="recording-bar" role="status" aria-label="Recording a voice message">
        <div className="flex items-center gap-3 px-4 py-3">
          <button type="button" onClick={recorder.cancel} aria-label="Discard recording" title="Discard recording" className="rounded-control p-2 text-danger-700 hover:bg-danger-100/50" data-testid="recording-cancel"><Trash2 size={18} /></button>
          <span className="size-2.5 animate-pulse rounded-full bg-danger-600 motion-reduce:animate-none" aria-hidden="true" />
          <span className="text-sm font-medium tabular-nums text-ink" data-testid="recording-time">{formatDuration(recorder.seconds)}</span>
          {/* The live input level: if this does not move when you speak, the message would be empty. */}
          <div className="flex h-5 flex-1 items-center gap-[3px]" aria-hidden="true" data-testid="recording-meter" data-level={recorder.level.toFixed(2)}>
            {Array.from({ length: 24 }).map((_, i) => (
              <span key={i} className={`w-1 rounded-full transition-colors duration-75 ${i / 24 < recorder.level ? "bg-primary-600" : "bg-primary-600/20"}`} style={{ height: `${6 + (i % 5) * 3}px` }} />
            ))}
          </div>
          <Button type="button" variant="primary" onClick={() => void sendRecording()} disabled={busy} data-testid="recording-send"><Send size={14} className="mr-1.5" aria-hidden="true" />Send</Button>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 px-4 pb-2 text-[11px] text-ink-2" data-testid="recording-device">
          <span>Microphone: <span className="font-medium text-ink">{recorder.device || "default"}</span></span>
          {recorder.muted && <span role="alert" className="font-medium text-danger-700" data-testid="recording-muted">The microphone is muted.</span>}
          {!recorder.muted && recorder.quiet && <span role="alert" className="font-medium text-danger-700" data-testid="recording-quiet">No sound is being picked up. Check your microphone.</span>}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-line">
      {staged && (
        <div className="flex items-center gap-2 border-b border-line bg-surface-muted px-4 py-2 text-xs" data-testid="staged-file">
          <Paperclip size={14} className="shrink-0 text-ink-2" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{staged.file.name}</span>
          <span className="shrink-0 text-ink-2">{size(staged.file.size)}</span>
          <button type="button" onClick={() => setStaged(null)} aria-label="Remove file" title="Remove file" className="rounded-control p-1 text-ink-2 hover:bg-surface" data-testid="staged-remove"><X size={14} /></button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex items-center gap-1 px-4 py-3"
      >
        <EmojiPicker onPick={addEmoji} disabled={disabled} />
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger asChild>
            <button type="button" aria-label="Attach a file" title="Attach a file" disabled={disabled} className="rounded-control p-2 text-ink-2 hover:bg-surface-muted disabled:opacity-50 data-[state=open]:bg-surface-muted" data-testid="attach-button"><Paperclip size={18} /></button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="floating z-(--z-popover) w-48 rounded-[14px] p-1.5 text-ink outline-none" data-testid="attach-menu">
              {ATTACH.map(({ kind, label, icon: Icon, tint }) => (
                <button key={kind} type="button" onClick={() => { setMenuOpen(false); pickers.current[kind]?.click(); }} className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm hover:bg-surface-muted" data-testid={`attach-${kind}`}>
                  <Icon size={16} className={tint} aria-hidden="true" /> {label}
                </button>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {ATTACH.map(({ kind, accept }) => (
          <input key={kind} ref={(el) => { pickers.current[kind] = el; }} type="file" className="hidden" accept={accept} aria-label={`Choose a ${kind} file`} data-testid={`file-${kind}`} onChange={(e) => { const file = e.target.files?.[0]; e.currentTarget.value = ""; if (file) stage(file, kind); }} />
        ))}
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={staged ? "Add a caption…" : placeholder}
          aria-label="Message"
          disabled={locked}
          className="mx-1 h-9 flex-1 rounded-control border border-line-strong bg-surface px-3 text-xs text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500 disabled:bg-surface-muted"
        />
        {draft.trim() || staged ? (
          <Button type="submit" variant="primary" disabled={disabled} data-testid="composer-send">{busy ? "Sending…" : "Send"}</Button>
        ) : (
          <button type="button" onClick={() => void recorder.start()} disabled={disabled || recorder.state === "starting"} aria-label="Record a voice message" title="Record a voice message" className="rounded-control bg-primary-600 p-2 text-white hover:bg-primary-700 disabled:opacity-50" data-testid="record-button">
            {recorder.state === "starting" ? <Square size={18} /> : <Mic size={18} />}
          </button>
        )}
      </form>
    </div>
  );
}
