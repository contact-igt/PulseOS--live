"use client";

import { useState } from "react";
import { AlertCircle, Check, CheckCheck, ExternalLink, FileText, Film, Image as ImageIcon, Phone, Reply, RotateCw } from "lucide-react";
import { api } from "@pulseos/api-client";
import { relativeTime } from "@pulseos/ui";
import type { MessageRow } from "@pulseos/types";
import { AttachmentView } from "./AttachmentView";
import { describeMessage, type DeliveryTone } from "./messagePresentation";
import { parseTemplateBody, type TemplateButton, type TemplateHeader } from "./templateMessage";
import { WhatsAppText } from "./WhatsAppMessageText";

const BUBBLE: Record<string, string> = {
  patient: "border-line bg-surface",
  ai: "border-primary-200 bg-surface-info",
  staff: "border-primary-200 bg-primary-100",
};
const STATUS_TEXT: Record<DeliveryTone, string> = { pending: "text-ink-2", ok: "text-ink-2", read: "text-primary-700", failed: "text-danger-700" };

/** The media at the top of a template message, flush to the bubble's edges as in WhatsApp. Without an address it is a placeholder. */
function TemplateHeaderMedia({ header }: { header: TemplateHeader }) {
  const [broken, setBroken] = useState(false);
  const Icon = header.kind === "video" ? Film : header.kind === "document" ? FileText : ImageIcon;
  const placeholder = (label: string) => (
    <div className="flex h-32 items-center justify-center gap-2 bg-black/5 text-xs text-ink-2" data-testid="template-header-placeholder"><Icon size={22} aria-hidden="true" /> {label}</div>
  );
  if (!header.url || broken) return placeholder(header.kind === "document" ? "Document" : header.kind === "video" ? "Video" : "Image");
  if (header.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- an address WhatsNexus stored with the template; no-referrer so nothing about this page is sent to it
    return <img src={header.url} alt="Template header" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="max-h-56 w-full object-cover" data-testid="template-header-image" />;
  }
  if (header.kind === "video") return <video src={header.url} controls preload="metadata" onError={() => setBroken(true)} className="max-h-56 w-full bg-black object-cover" data-testid="template-header-video" />;
  return (
    <a href={header.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-3 bg-black/[0.04] px-3 py-3 hover:bg-black/[0.07]" data-testid="template-header-document">
      <span className="flex size-10 items-center justify-center rounded-lg bg-primary-100 text-primary-700"><FileText size={18} aria-hidden="true" /></span>
      <span className="flex-1 text-sm font-medium">Document</span>
    </a>
  );
}

/** A template's buttons, below the bubble as WhatsApp draws them. Links open safely; a quick reply is shown but is only for the patient. */
function TemplateButtons({ buttons }: { buttons: TemplateButton[] }) {
  const base = "flex items-center justify-center gap-1.5 rounded-card border border-line bg-surface px-3 py-1.5 text-center text-xs font-medium text-primary-700";
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="template-buttons">
      {buttons.map((b, i) =>
        b.type === "url" ? (
          <a key={i} href={b.value!} target="_blank" rel="noopener noreferrer nofollow" className={`${base} hover:bg-surface-info`}><ExternalLink size={12} aria-hidden="true" /> {b.text}</a>
        ) : b.type === "phone" ? (
          <a key={i} href={`tel:${b.value!.replace(/[^\d+]/g, "")}`} className={`${base} hover:bg-surface-info`}><Phone size={12} aria-hidden="true" /> {b.text}</a>
        ) : (
          <span key={i} className={base}><Reply size={12} aria-hidden="true" /> {b.text}</span>
        ),
      )}
    </div>
  );
}

/**
 * One message in the thread, laid out as WhatsNexus's chat lays it out: photos as previews, documents as file cards, voice notes
 * with the WhatsApp-style player, template messages with their header media, formatted body and buttons. Who wrote it is said in
 * words (and by side), a sent message says where it has got to, and a failed one can be sent again as the same message.
 */
export function MessageBubble({ message, conversationId, onRetry, retrying }: { message: MessageRow; conversationId: string; onRetry: (messageId: string) => void; retrying: boolean }) {
  const v = describeMessage(message);
  if (v.side === "center") return <p className="text-center text-[11px] italic text-ink-2">{message.body}</p>;
  const failed = v.status?.tone === "failed";
  const template = message.kind === "template" ? parseTemplateBody(message.body) : null;
  const text = template ? template.body : message.body;
  const hasHeader = !!template?.header;

  return (
    <div className={`flex ${v.side === "left" ? "justify-start" : "justify-end"}`} data-testid={`message-${message.id}`} data-delivery={message.deliveryStatus ?? "none"} data-kind={message.kind}>
      <div className="flex max-w-[75%] flex-col">
        <div className={`overflow-hidden rounded-card border px-3 py-2 text-xs text-ink ${BUBBLE[v.tone]} ${failed ? "border-danger-300" : ""}`}>
          {hasHeader && <div className="-mx-3 -mt-2 mb-2"><TemplateHeaderMedia header={template!.header!} /></div>}
          {message.attachments.map((attachment) => (
            <AttachmentView key={attachment.id} attachment={attachment} href={api.conversationAttachmentUrl(conversationId, message.id, attachment.id)} />
          ))}
          {text && <WhatsAppText text={text} className={`text-[13px] leading-relaxed ${message.attachments.length ? "mt-1.5" : ""}`} />}
          {!text && message.attachments.length === 0 && !hasHeader && <p className="italic text-ink-2" data-testid="message-empty">This message has no text or file that can be shown here.</p>}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-2">
            <span data-testid="message-author">{v.label}</span>
            <span>· {relativeTime(message.sentAt)}</span>
            {message.kind === "template" && (
              <span className="max-w-[12rem] truncate rounded-chip bg-primary-50 px-1.5 text-primary-700" title={message.templateName ?? undefined} data-testid="message-template-tag">
                Template{message.templateName ? ` · ${message.templateName}` : ""}
              </span>
            )}
            {v.status && (
              <span className={`inline-flex items-center gap-1 font-medium ${STATUS_TEXT[v.status.tone]}`} data-testid="message-status">
                {v.status.tone === "failed" ? <AlertCircle size={12} aria-hidden="true" /> : v.status.text === "Sent" ? <Check size={12} aria-hidden="true" /> : v.status.tone === "pending" ? null : <CheckCheck size={12} aria-hidden="true" />}
                {v.status.text}
              </span>
            )}
            {v.canRetry && (
              <button type="button" onClick={() => onRetry(message.id)} disabled={retrying} className="inline-flex items-center gap-1 rounded-control border border-danger-300 bg-surface px-1.5 py-0.5 font-medium text-danger-700 hover:bg-danger-100/50 disabled:opacity-50" data-testid="message-retry">
                <RotateCw size={11} aria-hidden="true" /> {retrying ? "Sending…" : "Retry"}
              </button>
            )}
          </p>
        </div>
        {template && template.buttons.length > 0 && <TemplateButtons buttons={template.buttons} />}
      </div>
    </div>
  );
}
