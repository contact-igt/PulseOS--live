"use client";

import { useRef, useState } from "react";
import { Mic, Pause, Play } from "lucide-react";
import { formatDuration } from "./voiceRecorder";

// The same 33-bar envelope WhatsNexus draws, so a voice note looks the same in both places.
const WAVE = [3, 5, 9, 6, 12, 7, 4, 10, 6, 8, 4, 13, 7, 5, 10, 6, 11, 4, 8, 5, 10, 6, 3, 9, 5, 8, 4, 11, 6, 8, 3, 5, 7];

/**
 * A voice note as WhatsApp shows it: mic, waveform you can click to seek, the time (length, then how far it has played) and a
 * round play/pause button. If the audio cannot be loaded it says so instead of showing a dead 0:00 player.
 */
export function VoiceNotePlayer({ src, label }: { src: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-ink-2" data-testid="voice-unavailable">
        <Mic size={14} aria-hidden="true" /> <span>Audio unavailable</span>
      </div>
    );
  }

  const known = Number.isFinite(duration) && duration > 0;
  const progress = known ? (current / duration) * 100 : 0;
  const shown = playing || current > 0 ? current : known ? duration : 0;

  return (
    <div className="flex min-w-[220px] max-w-[270px] items-center gap-2 py-0.5" data-testid="voice-note">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        aria-label={label}
        onTimeUpdate={() => setCurrent(audio.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audio.current?.duration ?? 0)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-600/15 text-primary-700" aria-hidden="true"><Mic size={16} /></div>
      <div className="flex flex-1 flex-col gap-1">
        <div className="relative h-[22px]">
          <div className="flex h-full items-center gap-[2.5px]" aria-hidden="true">
            {WAVE.map((h, i) => (
              <div key={i} style={{ height: `${h}px` }} className={`flex-1 rounded-full ${(i / WAVE.length) * 100 < progress ? "bg-primary-600" : "bg-primary-600/25"}`} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={known ? duration : 100}
            step={0.01}
            value={current}
            aria-label="Seek"
            onChange={(e) => {
              const t = Number(e.target.value);
              if (audio.current) audio.current.currentTime = t;
              setCurrent(t);
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>
        <span className="text-[11px] tabular-nums leading-none text-ink-2" data-testid="voice-time">{formatDuration(shown)}</span>
      </div>
      <button
        type="button"
        onClick={() => { const a = audio.current; if (!a) return; if (playing) a.pause(); else void a.play().catch(() => setFailed(true)); }}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white transition-transform hover:bg-primary-700 active:scale-95"
        data-testid="voice-toggle"
      >
        {playing ? <Pause size={15} fill="currentColor" stroke="none" /> : <Play size={15} fill="currentColor" stroke="none" className="ml-0.5" />}
      </button>
    </div>
  );
}
