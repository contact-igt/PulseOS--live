import { createHash } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Db } from "../../db/client.js";
import { hospitalInvitationDeliveries as deliveries, hospitalOnboardings as onboardings, platformAuditLog, tenants, users } from "../../db/schema.js";
import { decryptSecret } from "../security/encryption.js";

export const invitationEmailEnabled = () => process.env.HOSPITAL_INVITATION_EMAIL_ENABLED === "true";
export const invitationCooldownMs = 60_000;

export type InvitationMail = { to: string; hospital: string; token: string; expiresAt: Date; messageId: string };
class MailUnavailable extends Error {}
class MailRejected extends Error {}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export async function sendHospitalInvitationEmail(mail: InvitationMail) {
  const { HOSPITAL_INVITATION_WEB_ORIGIN, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = process.env;
  const origin = URL.canParse(HOSPITAL_INVITATION_WEB_ORIGIN ?? "") ? new URL(HOSPITAL_INVITATION_WEB_ORIGIN!) : null;
  const port = Number(SMTP_PORT ?? 587);
  if (!origin || origin.protocol !== "https:" || origin.username || origin.password || origin.href !== origin.origin + "/" ||
    !SMTP_HOST || !SMTP_FROM || !SMTP_USER || !SMTP_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) throw new MailUnavailable();
  const url = new URL("/hospital-invitation", origin);
  url.hash = mail.token;
  const expires = mail.expiresAt.toISOString();
  const text = `You were invited to set up administrator access for ${mail.hospital} in PulseOS.\n\nSet your password: ${url.href}\n\nThis single-use link expires at ${expires}. If you need help, contact the PulseOS team that created your hospital.\n`;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail({
      from: SMTP_FROM, to: { name: "", address: mail.to }, messageId: `<${mail.messageId}@${origin.hostname}>`,
      subject: "Set up your PulseOS hospital administrator account", text,
      html: `<!doctype html><html lang="en"><body style="margin:0;background:#f5f7fb;padding:16px;font:16px/1.5 Arial,sans-serif;color:#182230"><main style="max-width:540px;margin:auto;background:white;padding:24px;border-radius:12px"><p style="font-weight:bold;color:#175cd3">PulseOS</p><h1 style="font-size:24px">Set up your administrator account</h1><p>You were invited to manage <strong>${escapeHtml(mail.hospital)}</strong> in PulseOS.</p><p><a style="display:inline-block;background:#175cd3;color:white;padding:12px 18px;border-radius:8px" href="${escapeHtml(url.href)}">Set your password</a></p><p>This single-use link expires at ${escapeHtml(expires)}.</p><p>If you need help, contact the PulseOS team that created your hospital.</p></main></body></html>`,
    });
    if (!result.accepted.length || result.rejected.length) throw new MailRejected();
  } finally {
    transport.close();
  }
}

export async function processHospitalInvitationDeliveries(db: Db, now: Date,
  send: (mail: InvitationMail) => Promise<void> = sendHospitalInvitationEmail) {
  if (!invitationEmailEnabled()) return;
  const due = await db.select({ id: deliveries.onboardingId }).from(deliveries)
    .where(and(eq(deliveries.status, "pending"), lte(deliveries.nextAttemptAt, now))).orderBy(deliveries.nextAttemptAt).limit(5);
  for (const { id } of due) await db.transaction(async (tx) => {
    // Same lock order as issuance and redemption. A retry always uses the same credential.
    const [onboarding] = await tx.select().from(onboardings).where(eq(onboardings.id, id)).for("update");
    const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.onboardingId, id)).for("update");
    if (!onboarding || !delivery || delivery.status !== "pending" || delivery.nextAttemptAt > now) return;
    const save = (patch: Partial<typeof deliveries.$inferInsert>) => tx.update(deliveries).set(patch).where(eq(deliveries.onboardingId, id));
    if (!onboarding.invitationExpiresAt || +onboarding.invitationExpiresAt <= Math.max(+now, Date.now())) {
      await save({ status: "expired", encryptedToken: null });
      return;
    }
    if (onboarding.invitationRedeemedAt || !onboarding.tenantId || !onboarding.adminId || !delivery.encryptedToken) {
      await save({ status: "superseded", encryptedToken: null });
      return;
    }
    const [owner] = await tx.select({ email: users.email, hospital: tenants.name, active: tenants.loginEnabled })
      .from(users).innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(and(eq(users.id, onboarding.adminId), eq(users.tenantId, onboarding.tenantId), eq(users.role, "SUPER_ADMIN"),
        eq(tenants.lifecycleStatus, "PROVISIONING")))
      .for("share");
    const attempts = delivery.attempts + 1;
    const lastAttemptAt = new Date();
    let failure: string | null = null;
    try {
      const payload = decryptSecret(delivery.encryptedToken);
      if (!owner || owner.active || typeof payload.token !== "string" || payload.recipient !== owner.email ||
        createHash("sha256").update(payload.token).digest("hex") !== onboarding.invitationHash) {
        await save({ status: "superseded", encryptedToken: null, failure: "recipient_or_invitation_changed" });
        return;
      }
      await send({ to: owner.email, hospital: owner.hospital, token: payload.token,
        expiresAt: onboarding.invitationExpiresAt, messageId: delivery.messageId });
    } catch (error) {
      failure = error instanceof MailUnavailable ? "mail_not_configured" : error instanceof MailRejected ? "recipient_rejected" : "mail_attempt_failed";
    }
    const terminal = Boolean(failure) && attempts >= 3;
    await save({
      status: failure ? terminal ? "failed" : "pending" : "accepted", attempts, lastAttemptAt, failure,
      nextAttemptAt: new Date(+now + 60_000 * 2 ** attempts),
      encryptedToken: failure && !terminal ? delivery.encryptedToken : null,
    });
    await tx.insert(platformAuditLog).values({ onboardingId: id,
      action: failure ? "invitation_email_attempt_failed" : "invitation_email_accepted", reason: failure });
  });
}
