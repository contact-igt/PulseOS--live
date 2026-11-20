import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlatformPermission } from "@pulseos/types";
import { authorizeHospitalOperator } from "../tenant/hospital-onboarding.service.js";
import { browserAccount, operatorPermissions } from "./platform-auth.service.js";

export const PLATFORM_COOKIE = "pulseos_platform_session";
export const ENROLLMENT_COOKIE = "pulseos_platform_enrollment";

export function platformOrigin(origin: string | undefined) {
  const configured = process.env.PLATFORM_WEB_ORIGIN;
  const production = process.env.NODE_ENV === "production";
  try {
    const allowed = new URL(configured ?? (production ? "" : "http://localhost:3310"));
    if (allowed.protocol !== "https:" && (production || allowed.protocol !== "http:")) return null;
    return origin === allowed.origin ? origin : null;
  } catch {
    return null;
  }
}

export function browserWrite(request: FastifyRequest) {
  return Boolean(platformOrigin(request.headers.origin) && request.headers["x-pulseos-platform"] === "1");
}

export function platformCookieOptions() {
  return { path: "/platform", httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production" };
}

export type PlatformActor = { kind: "operator" | "browser"; id: string };

export function requirePlatform(permission: PlatformPermission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const credential = request.headers.authorization;
    if (credential !== undefined) {
      if (request.cookies.pulseos_session || request.cookies[PLATFORM_COOKIE] || request.headers.origin || request.headers["sec-fetch-site"]) {
        return reply.status(403).send({ error: "platform_credentials_required" });
      }
      const actor = await authorizeHospitalOperator(request.server.db, credential);
      if (!actor) return reply.status(401).send({ error: "platform_credentials_required" });
      if (!operatorPermissions.includes(permission)) return reply.status(403).send({ error: "forbidden" });
      request.platformActor = { kind: "operator", id: actor.id };
      return;
    }
    if (request.method !== "GET" && !browserWrite(request) && request.cookies[PLATFORM_COOKIE]) {
      return reply.status(403).send({ error: "cross_origin_request_blocked" });
    }
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if ((origin && !platformOrigin(origin)) || (!origin && fetchSite && fetchSite !== "same-origin")) {
      return reply.status(403).send({ error: "cross_origin_request_blocked" });
    }
    const account = await browserAccount(request.server.db, request.cookies[PLATFORM_COOKIE]);
    if (!account) return reply.status(request.cookies.pulseos_session ? 403 : 401).send({ error: "platform_credentials_required" });
    if (!account.permissions.includes(permission)) return reply.status(403).send({ error: "forbidden" });
    request.platformAccount = account;
    request.platformActor = { kind: "browser", id: account.id };
  };
}

declare module "fastify" {
  interface FastifyRequest {
    platformActor: PlatformActor | null;
    platformAccount: import("@pulseos/types").PlatformAccount | null;
  }
}
