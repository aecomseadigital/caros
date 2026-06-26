import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// S2 — contract-lint the APIM inbound policy so an edit can't silently drop a guard.
const policy = readFileSync(join(__dirname, "..", "apim-policy.xml"), "utf8");

describe("S2 APIM policy contract", () => {
  it("S2.1 validates JWT, pins the audience, and requires the hackathon role", () => {
    expect(policy).toMatch(/<validate-jwt[\s\S]*?>/);
    expect(policy).toContain("api://ea4c58eb-9223-46bd-89cc-06bf4652f43c");
    expect(policy).toMatch(/<claim name="roles"[\s\S]*?<value>hackathon<\/value>/);
    expect(policy).toContain('failed-validation-httpcode="403"');
  });

  it("S2.2 pins the v1 issuer metadata (no /v2.0) for the tenant", () => {
    const m = policy.match(/<openid-config url="([^"]+)"/);
    expect(m, "openid-config must be present").toBeTruthy();
    expect(m![1]).toContain("16ed5ab4-2b59-4e40-806d-8a30bdc9cf26");
    expect(m![1]).not.toContain("/v2.0"); // tokens are v1.0 (iss = sts.windows.net)
  });

  it("S2.4 injects identity + secret headers with override (clients cannot spoof them)", () => {
    for (const h of ["x-user-oid", "x-user-upn", "x-gateway-secret"]) {
      const re = new RegExp(`<set-header name="${h}" exists-action="override">`);
      expect(policy, `${h} must be set with exists-action="override"`).toMatch(re);
    }
  });

  it("S2.5 sources the gateway secret from a named value, not an inline literal", () => {
    expect(policy).toMatch(/<set-header name="x-gateway-secret"[\s\S]*?\{\{gw-secret\}\}/);
  });
});
