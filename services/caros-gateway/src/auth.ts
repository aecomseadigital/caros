import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { config } from "./config";

export interface CallerIdentity {
  oid: string;
  upn: string;
}

/** Constant-time string comparison to avoid leaking the secret via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * APIM validates the Entra JWT and injects the shared secret before forwarding.
 * The gateway has a PUBLIC ingress, so this is the only thing stopping direct,
 * APIM-bypassing calls. Fail closed: with no secret configured we reject every
 * request unless ALLOW_INSECURE_NO_SECRET is explicitly set (local dev only).
 */
export function verifySharedSecret(req: Request): boolean {
  if (!config.sharedSecret) return config.allowInsecureNoSecret;
  return safeEqual(req.header(config.headers.secret) ?? "", config.sharedSecret);
}

export function getCaller(req: Request): CallerIdentity {
  return {
    oid: req.header(config.headers.userOid) ?? "unknown",
    upn: req.header(config.headers.userUpn) ?? "unknown",
  };
}
