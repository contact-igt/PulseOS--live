"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Formats the browser may record in, best first: ogg/opus and webm/opus are what WhatsNexus converts for WhatsApp; mp4 is Safari's. */
const CANDIDATES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
  return CANDIDATES.find((m) => isSupported(m)) ?? null;
}

export function recordingFileName(mime: string, at: number): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  const ext = base === "audio/ogg" ? "ogg" : base === "audio/mp4" ? "m4a" : "webm";
  return `voice-${at}.${ext}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Is the microphone actually picking anything up? A muted, wrong or privacy-blocked microphone does not always fail: the
// browser can record the right length of digital silence, which reaches the patient as an empty voice message. So the level
// is watched while recording, shown to the person, and a recording that never rose above the noise floor is not sent.
// ---------------------------------------------------------------------------

/** Loudness of a block of samples (-1…1): the root-mean-square. */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

const METER_FLOOR_DB = -60;
const METER_CEIL_DB = -10;

/** A 0 to 1 meter on a decibel scale: empty at -60 dB or quieter, full at -10 dB or louder (speech sits well up the scale). */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)));
}

/** About -50 dBFS: a quiet room is above this, a muted or broken microphone is far below it. */
export const SOUND_RMS_THRESHOLD = 0.003;

export const hasSound = (peakRms: number): boolean => peakRms >= SOUND_RMS_THRESHOLD;

export function silentRecordingMessage(deviceLabel: string | null): string {
  const device = deviceLabel?.trim() ? ` The browser used “${deviceLabel.trim()}”.` : "";
  return `No sound was picked up, so the voice message was not sent.${device} Check that this is the microphone you are speaking into and that it is not muted, then record again.`;
}

/** A voice message longer than this is stopped for the person (WhatsApp's file limit is 16 MB; opus is far smaller). */
export const MAX_RECORDING_SECONDS = 10 * 60;

function microphoneProblem(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in the browser's address bar, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is being used by another app.";
  return "The recording could not be started.";
}

export type RecorderState = "idle" | "starting" | "recording";
export interface RecordingResult {
  file: File | null;
  /** False when the input never rose above the noise floor. True when it was not possible to measure (nothing is blocked on a guess). */
  heardSound: boolean;
  /** The microphone the browser recorded from. */
  device: string | null;
}

/**
 * Record a voice message in the browser. start() asks for the microphone; stop() resolves with the recording and whether it
 * contains sound; cancel() throws it away. While recording, `level` (0 to 1) follows the input and `device` names the microphone.
 * Releases the microphone whatever happens, including when the page closes.
 */
export function useVoiceRecorder(onProblem: (message: string) => void) {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [device, setDevice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // Two seconds in and still nothing above the noise floor: tell the person now, not after they have finished talking.
  const [quiet, setQuiet] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const meter = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const peak = useRef(0);
  const measured = useRef(false);
  const label = useRef<string | null>(null);
  const finish = useRef<((r: RecordingResult) => void) | null>(null);
  const discard = useRef(false);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    if (meter.current) clearInterval(meter.current);
    timer.current = null;
    meter.current = null;
    void audioContext.current?.close().catch(() => {});
    audioContext.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = [];
    setSeconds(0);
    setLevel(0);
    setMuted(false);
    setQuiet(false);
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onProblem("This browser cannot record voice messages. Use Attach → Audio file instead.");
      return;
    }
    setState("starting");
    try {
      // One clean voice channel: WhatsApp voice messages are mono, and the browser's own noise handling helps speech.
      const wanted: MediaStreamConstraints = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      const media = await navigator.mediaDevices.getUserMedia(wanted).catch((e: unknown) => {
        if ((e as { name?: string } | null)?.name === "OverconstrainedError") return navigator.mediaDevices.getUserMedia({ audio: true });
        throw e;
      });
      stream.current = media;
      const track = media.getAudioTracks()[0];
      label.current = track?.label || null;
      setDevice(label.current);
      if (track) {
        track.onmute = () => setMuted(true);
        track.onunmute = () => setMuted(false);
        setMuted(track.muted);
      }

      // Watch the input so the person can see the microphone is working, and so silence can be caught.
      peak.current = 0;
      measured.current = false;
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          audioContext.current = ctx;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaStreamSource(media).connect(analyser);
          const buf = new Float32Array(analyser.fftSize);
          measured.current = true;
          const startedAt = Date.now();
          meter.current = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            const rms = rmsOf(buf);
            peak.current = Math.max(peak.current, rms);
            setLevel(meterLevel(rms));
            setQuiet(Date.now() - startedAt > 2000 && !hasSound(peak.current));
          }, 100);
        }
      } catch {
        measured.current = false; // cannot measure: nothing is blocked on a guess
      }

      const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = mime ? new MediaRecorder(media, { mimeType: mime }) : new MediaRecorder(media);
      chunks.current = [];
      discard.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        const file = !discard.current && blob.size > 0 ? new File([blob], recordingFileName(type, Date.now()), { type }) : null;
        const result: RecordingResult = { file, heardSound: measured.current ? hasSound(peak.current) : true, device: label.current };
        const done = finish.current;
        finish.current = null;
        release();
        done?.(result);
      };
      rec.start(250);
      recorder.current = rec;
      setSeconds(0);
      setState("recording");
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      release();
      onProblem(microphoneProblem(err));
    }
  }, [onProblem, release, state]);

  const stop = useCallback((): Promise<RecordingResult> => {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return Promise.resolve({ file: null, heardSound: true, device: label.current });
    return new Promise((resolve) => {
      discard.current = false;
      finish.current = resolve;
      rec.stop();
    });
  }, []);

  const cancel = useCallback(() => {
    const rec = recorder.current;
    discard.current = true;
    if (rec && rec.state !== "inactive") rec.stop();
    else release();
  }, [release]);

  useEffect(() => {
    if (state === "recording" && seconds >= MAX_RECORDING_SECONDS) void stop();
  }, [seconds, state, stop]);

  // Leaving the page must never leave the microphone on.
  useEffect(() => () => {
    discard.current = true;
    if (timer.current) clearInterval(timer.current);
    if (meter.current) clearInterval(meter.current);
    void audioContext.current?.close().catch(() => {});
    stream.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return { state, seconds, level, device, muted, quiet, start, stop, cancel };
}
