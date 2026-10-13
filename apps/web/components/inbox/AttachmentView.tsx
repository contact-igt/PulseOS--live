"use client";

import { useState } from "react";
import { Download, FileText, Film, Image as ImageIcon } from "lucide-react";
import type { MessageRow } from "@pulseos/types";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

type Attachment = MessageRow["attachments"][number];

const size = (bytes: number | null) => (bytes == null ? null : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const extensionOf = (name: string | null, fallback: string) => (name?.includes(".") ? name.split(".").pop()!.slice(0, 5).toUpperCase() : fallback);

function Unavailable({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="mt-1 flex items-center gap-2 rounded-control border border-line bg-surface-muted px-2.5 py-2 text-xs text-ink-2" data-testid="attachment-unavailable">
      {icon} <span>{text}</span>
    </div>
  );
}

/**
 * One attachment as WhatsNexus's chat shows it: a photo as a preview you can open, a video you can play, a document as a file
 * card (icon, name, type, size, download), a voice note with the WhatsApp-style player. A file that cannot be loaded says so.
 */
export function AttachmentView({ attachment, href }: { attachment: Attachment; href: string }) {
  const [broken, setBroken] = useState(false);
  const name = attachment.fileName;

  if (attachment.kind === "audio") return <VoiceNotePlayer src={href} label={name ?? "Voice message"} />;

  if (attachment.kind === "image") {
    if (broken) return <Unavailable icon={<ImageIcon size={15} aria-hidden="true" />} text="Image unavailable" />;
    return (
      <a href={href} target="_blank" rel="noreferrer" className="mt-1 block overflow-hidden rounded-control" title="Open the full image" data-testid="attachment-image">
        {/* eslint-disable-next-line @next/next/no-img-element -- served through PulseOS with the session; next/image would not send it */}
        <img src={href} alt={name ?? "Photo"} loading="lazy" onError={() => setBroken(true)} className="max-h-64 max-w-full object-cover" />
      </a>
    );
  }

  if (attachment.kind === "video") {
    if (broken) return <Unavailable icon={<Film size={15} aria-hidden="true" />} text="Video unavailable" />;
    return <video controls preload="metadata" src={href} onError={() => setBroken(true)} aria-label={name ?? "Video"} className="mt-1 max-h-64 w-full max-w-sm rounded-control bg-black" data-testid="attachment-video" />;
  }

  const ext = extensionOf(name, "FILE");
  const meta = [ext, size(attachment.sizeBytes)].filter(Boolean).join(" · ");
  return (
    <a href={href} target="_blank" rel="noreferrer" className="mt-1 flex min-w-[220px] max-w-[300px] items-center gap-3 rounded-control border border-line bg-surface px-3 py-2.5 text-ink transition-colors hover:border-primary-300 hover:bg-surface-info" data-testid="attachment-document">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700" aria-hidden="true"><FileText size={18} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name ?? "Document"}</span>
        <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-3">{meta}</span>
      </span>
      <Download size={16} className="shrink-0 text-ink-3" aria-label="Download" />
    </a>
  );
}
