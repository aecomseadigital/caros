import type { Request } from "express";
import { config } from "./config";

export interface CallerIdentity {
  oid: string;
  upn: string;
}

/**
 * APIM validates the Entra JWT and injects a shared secret before forwarding.
 * If GATEWAY_SHARED_SECRET is unset (local dev), the check is skipped.
 */
export function verifySharedSecret(req: Request): boolean {
  if (!config.sharedSecret) return true;
  return req.header(config.headers.secret) === config.sharedSecret;
}

export function getCaller(req: Request): CallerIdentity {
  return {
    oid: req.header(config.headers.userOid) ?? "unknown",
    upn: req.header(config.headers.userUpn) ?? "unknown",
  };
}
