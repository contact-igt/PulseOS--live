import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PlatformPermission, PlatformRole } from "@pulseos/types";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const platformAccounts = pgTable("platform_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  role: text("role").$type<PlatformRole>().notNull(),
  permissions: text("permissions").array().$type<PlatformPermission[]>().notNull().default([]),
  passwordHash: text("password_hash"),
  mfaSecret: text("mfa_secret"),
  lastMfaStep: integer("last_mfa_step"),
  setupHash: text("setup_hash").unique(),
  setupExpiresAt: time("setup_expires_at"),
  disabledAt: time("disabled_at"),
});

export const platformSessions = pgTable("platform_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => platformAccounts.id),
  lastSeenAt: time("last_seen_at").notNull().defaultNow(),
  expiresAt: time("expires_at").notNull(),
  revokedAt: time("revoked_at"),
}, (t) => [index("platform_sessions_account_idx").on(t.accountId)]);

export const platformEnrollments = pgTable("platform_enrollments", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id").notNull().unique().references(() => platformAccounts.id),
  passwordHash: text("password_hash").notNull(),
  mfaSecret: text("mfa_secret").notNull(),
  expiresAt: time("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
});

export const platformMfaRecoveries = pgTable("platform_mfa_recoveries", {
  accountId: uuid("account_id").primaryKey().references(() => platformAccounts.id),
  requestedBy: uuid("requested_by").references(() => platformAccounts.id),
  status: text("status").$type<"pending" | "approved" | "completed" | "rejected">().notNull(),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
  operatorCase: text("operator_case"),
});

export const platformSecurityAudit = pgTable("platform_security_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => platformAccounts.id),
  subjectId: uuid("subject_id").references(() => platformAccounts.id),
  action: text("action").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [index("platform_security_audit_time_idx").on(t.createdAt, t.id)]);
