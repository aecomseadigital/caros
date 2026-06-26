import { describe, it, expect, afterEach } from "vitest";
import type { Request } from "express";
import { verifySharedSecret, getCaller } from "../src/auth";
import { config } from "../src/config";

function req(headers: Record<string, string>): Request {
  return { header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

describe("T1.B verifySharedSecret / getCaller", () => {
  const original = config.sharedSecret;
  const originalInsecure = config.allowInsecureNoSecret;
  afterEach(() => {
    config.sharedSecret = original;
    config.allowInsecureNoSecret = originalInsecure;
  });

  it("S1.1 no secret + fail-closed (default) -> reject", () => {
    config.sharedSecret = "";
    config.allowInsecureNoSecret = false;
    expect(verifySharedSecret(req({}))).toBe(false);
  });

  it("T1.B1 no secret + ALLOW_INSECURE_NO_SECRET (local dev) -> skip check (true)", () => {
    config.sharedSecret = "";
    config.allowInsecureNoSecret = true;
    expect(verifySharedSecret(req({}))).toBe(true);
  });

  it("T1.B2 secret set + matching header -> true", () => {
    config.sharedSecret = "s3cr3t";
    expect(verifySharedSecret(req({ "x-gateway-secret": "s3cr3t" }))).toBe(true);
  });

  it("T1.B3 secret set + missing/wrong header -> false", () => {
    config.sharedSecret = "s3cr3t";
    expect(verifySharedSecret(req({}))).toBe(false);
    expect(verifySharedSecret(req({ "x-gateway-secret": "nope" }))).toBe(false);
  });

  it("T1.B4 getCaller reads oid/upn, defaults to unknown", () => {
    expect(getCaller(req({ "x-user-oid": "abc", "x-user-upn": "a@b.com" }))).toEqual({
      oid: "abc",
      upn: "a@b.com",
    });
    expect(getCaller(req({}))).toEqual({ oid: "unknown", upn: "unknown" });
  });
});
