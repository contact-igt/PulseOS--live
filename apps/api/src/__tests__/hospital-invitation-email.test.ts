import { afterEach, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { sendHospitalInvitationEmail } from "../domain/tenant/hospital-invitation-delivery.service.js";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));
afterEach(() => vi.unstubAllEnvs());

it("formats a TLS SMTP invitation with a fragment link and an escaped hospital name", async () => {
  vi.stubEnv("HOSPITAL_INVITATION_WEB_ORIGIN", "https://pulseos.example.test");
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_USER", "synthetic");
  vi.stubEnv("SMTP_PASSWORD", "synthetic");
  vi.stubEnv("SMTP_FROM", "PulseOS <support@example.test>");
  const sendMail = vi.fn().mockResolvedValue({ accepted: ["admin@example.test"], rejected: [] });
  const close = vi.fn();
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);
  const token = "a".repeat(43);
  await sendHospitalInvitationEmail({ to: "admin@example.test", hospital: "Test <Hospital>",
    token, expiresAt: new Date("2026-11-20T00:00:00Z"), messageId: "fixture" });
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, debug: false }));
  expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
    to: { name: "", address: "admin@example.test" }, messageId: "<fixture@pulseos.example.test>",
    text: expect.stringContaining("https://pulseos.example.test/hospital-invitation#" + token),
    html: expect.stringContaining("Test &lt;Hospital&gt;"),
  }));
  expect(close).toHaveBeenCalledOnce();
});
