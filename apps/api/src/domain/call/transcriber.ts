import type { ConnectorMode } from "@pulseos/types";

// The transcription port. Call code only ever talks to this interface. No real speech-to-text provider is wired
// yet, so outside a FIXTURE connector nothing transcribes and the call says so honestly ("Transcription not
// configured") — it never pretends. A provider that already sends a transcript with the call event needs no
// transcriber at all: that text is stored as-is (mode PROVIDER).

export interface TranscriptionInput {
  callId: string;
  /** The stored provider recording reference. Never logged. */
  recordingRef: string;
  /** Call metadata the provider sent (non-secret). */
  metadata: Record<string, unknown>;
}

export interface Transcriber {
  provider: string;
  mode: "FIXTURE";
  /** Plain text, one "Patient:" / "Hospital:" line per turn where the speakers are known. Null = nothing to transcribe. */
  transcribe(input: TranscriptionInput): Promise<string | null>;
}

/**
 * Deterministic demo stand-in for a FIXTURE connector. It cannot hear audio: it returns the script the fixture
 * itself carries (`metadata.fixtureTranscript`), labelled FIXTURE everywhere it is shown, and returns nothing for a
 * call that carries none.
 */
export class FixtureTranscriber implements Transcriber {
  readonly provider = "fixture";
  readonly mode = "FIXTURE" as const;
  async transcribe(input: TranscriptionInput): Promise<string | null> {
    const script = input.metadata.fixtureTranscript;
    return typeof script === "string" && script.trim() ? script.trim() : null;
  }
}

/** Which transcriber (if any) applies to a call from a connector in this mode. */
export function getTranscriber(connectorMode: ConnectorMode | null, env: Record<string, string | undefined> = process.env): Transcriber | null {
  if (connectorMode === "FIXTURE" || env.PULSEOS_TRANSCRIPTION_PROVIDER === "fixture") return new FixtureTranscriber();
  return null;
}
