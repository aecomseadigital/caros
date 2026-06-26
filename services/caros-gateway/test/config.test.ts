import { describe, it, expect, afterEach } from "vitest";
import { config, deploymentFor } from "../src/config";
import { chatCompletionsUrl, aoaiAuthHeaders } from "../src/aoai";

describe("T1.C config + url helpers", () => {
  it("T1.C1 deploymentFor maps tiers to env-configured names", () => {
    expect(deploymentFor("mini")).toBe(config.aoai.deployments.mini);
    expect(deploymentFor("nano")).toBe(config.aoai.deployments.nano);
  });

  it("T1.C2 chatCompletionsUrl builds the AOAI path with api-version", () => {
    expect(chatCompletionsUrl("gpt-5.4-nano")).toBe(
      `${config.aoai.endpoint}/openai/deployments/gpt-5.4-nano/chat/completions?api-version=${config.aoai.apiVersion}`,
    );
  });

  it("T1.C2b endpoint trailing slashes are stripped", () => {
    expect(config.aoai.endpoint.endsWith("/")).toBe(false);
  });

  it("T1.C4 api_key mode with no key throws", async () => {
    const orig = config.aoai.apiKey;
    config.aoai.apiKey = "";
    try {
      await expect(aoaiAuthHeaders()).rejects.toThrow(/AZURE_OPENAI_API_KEY/);
    } finally {
      config.aoai.apiKey = orig;
    }
  });

  it("T1.C4b api_key mode with a key returns api-key header", async () => {
    config.aoai.authMode = "api_key";
    await expect(aoaiAuthHeaders()).resolves.toEqual({ "api-key": config.aoai.apiKey });
  });
});
