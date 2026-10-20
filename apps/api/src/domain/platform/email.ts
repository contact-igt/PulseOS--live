// Outgoing account email (invitations, password resets) behind one adapter - never `if provider === ...` in domain logic.
// PulseOS has no email provider yet. Outside production a local outbox keeps messages in memory for the developer (read
// only from the machine itself, see platform routes); in production nothing is sent and the console says so truthfully
// ("Not delivered") instead of pretending. A provider is a new EmailProvider implementation, nothing else changes.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** What the message is for, so the local outbox can be filtered. Never the token. */
  kind: "INVITE" | "PASSWORD_RESET";
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<{ delivered: boolean }>;
}

const OUTBOX_LIMIT = 100;

/** Development only: messages stay in this process's memory. Never enabled in production. */
export class LocalOutboxEmailProvider implements EmailProvider {
  readonly name = "local_outbox";
  readonly messages: (OutgoingEmail & { at: string })[] = [];
  async send(message: OutgoingEmail) {
    this.messages.unshift({ ...message, at: new Date().toISOString() });
    this.messages.length = Math.min(this.messages.length, OUTBOX_LIMIT);
    return { delivered: true };
  }
}

export class NoEmailProvider implements EmailProvider {
  readonly name = "none";
  async send() {
    return { delivered: false };
  }
}

let provider: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  provider ??= process.env.NODE_ENV === "production" ? new NoEmailProvider() : new LocalOutboxEmailProvider();
  return provider;
}

/** The local outbox, when this process has one (development). */
export function localOutbox(): LocalOutboxEmailProvider | null {
  const p = emailProvider();
  return p instanceof LocalOutboxEmailProvider ? p : null;
}

/** The web address account links point at: the first WEB_ORIGIN (the console and hospital app share one web origin). */
export function webBaseUrl(): string {
  const first = (process.env.WEB_ORIGIN ?? "").split(",")[0]?.trim();
  return first && /^https?:\/\//.test(first) ? first.replace(/\/$/, "") : "http://localhost:3310";
}
