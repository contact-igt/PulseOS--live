"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Smile } from "lucide-react";
import { EMOJI_GROUPS, pushRecent } from "./emoji";

const STORAGE_KEY = "pulseos.recentEmoji";

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

/**
 * An emoji button and popover for the message box. Tabs by group, plus the ones used most recently (kept in this browser only).
 * Picking one hands it to the message box and keeps the popover open, so several can be added in a row.
 */
export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [tab, setTab] = useState("smileys");

  const groups = recent.length > 0 ? [{ key: "recent", label: "Recently used", icon: "🕘", emojis: recent }, ...EMOJI_GROUPS] : EMOJI_GROUPS;
  const active = groups.find((g) => g.key === tab) ?? groups[0]!;

  function pick(emoji: string) {
    onPick(emoji);
    const next = pushRecent(recent, emoji);
    setRecent(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: the picker still works, it just does not remember.
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (next) setRecent(loadRecent()); setOpen(next); }}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Add emoji" title="Add emoji" disabled={disabled} className="rounded-control p-2 text-ink-2 hover:bg-surface-muted disabled:opacity-50 data-[state=open]:bg-surface-muted" data-testid="emoji-button">
          <Smile size={18} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="floating z-(--z-popover) w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-[14px] p-2 text-ink outline-none" data-testid="emoji-panel" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex gap-0.5 overflow-x-auto border-b border-line pb-1.5" role="tablist" aria-label="Emoji groups">
            {groups.map((g) => (
              <button key={g.key} type="button" role="tab" aria-selected={g.key === active.key} aria-label={g.label} title={g.label} onClick={() => setTab(g.key)} className={`shrink-0 rounded-control px-2 py-1 text-base ${g.key === active.key ? "bg-primary-100" : "hover:bg-surface-muted"}`} data-testid={`emoji-tab-${g.key}`}>
                {g.icon}
              </button>
            ))}
          </div>
          <p className="px-1 pt-1.5 text-[11px] font-medium text-ink-3">{active.label}</p>
          <div className="mt-1 grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto" role="tabpanel">
            {active.emojis.map((e) => (
              <button key={e} type="button" onClick={() => pick(e)} aria-label={e} className="flex size-8 items-center justify-center rounded-control text-xl hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary-500" data-testid="emoji-item">
                {e}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
