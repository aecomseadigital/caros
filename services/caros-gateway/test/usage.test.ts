import { describe, it, expect, vi, afterEach } from "vitest";
import { logUsage, normalizeUsage } from "../src/usage";

describe("T1.D logUsage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("T1.D1 emits a CarosUsage record with caller, routing, and token counts", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logUsage({
      caller: { oid: "oid-1", upn: "u@x.com" },
      deployment: "gpt-5.4-mini",
      tier: "mini",
      reason: "code_detected",
      stream: false,
      latencyMs: 42,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(rec).toMatchObject({
      evt: "CarosUsage",
      oid: "oid-1",
      upn: "u@x.com",
      deployment: "gpt-5.4-mini",
      tier: "mini",
      reason: "code_detected",
      stream: "false",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 42,
    });
  });

  it("T1.D2 / S7.1 missing usage -> zeros, and no message content is logged", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logUsage({
      caller: { oid: "oid-2", upn: "unknown" },
      deployment: "gpt-5.4-nano",
      tier: "nano",
      reason: "short_simple",
      stream: true,
      latencyMs: 7,
    });
    const raw = spy.mock.calls[0]![0] as string;
    const rec = JSON.parse(raw);
    expect(rec.promptTokens).toBe(0);
    expect(rec.completionTokens).toBe(0);
    expect(rec.totalTokens).toBe(0);
    // S7.1: only ids/counts, never prompt/response text
    expect(Object.keys(rec).sort()).toEqual(
      ["cachedFrac", "cachedTokens", "completionTokens", "deployment", "evt", "latencyMs", "oid", "promptTokens", "reason", "reasoningTokens", "stream", "tier", "totalTokens", "upn"].sort(),
    );
  });

  it("T1.D3 captures cached + reasoning tokens (chat-completions shape) and cachedFrac", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logUsage({
      caller: { oid: "oid-3", upn: "u@x.com" },
      deployment: "gpt-5.4-mini",
      tier: "mini",
      reason: "tools_present",
      stream: false,
      latencyMs: 11,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    });
    const rec = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(rec).toMatchObject({ promptTokens: 100, cachedTokens: 80, reasoningTokens: 12, cachedFrac: 0.8 });
  });

  it("T1.D4 normalizeUsage reads the Responses-API shape too", () => {
    expect(
      normalizeUsage({
        input_tokens: 50,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toEqual({ promptTokens: 50, completionTokens: 9, totalTokens: 59, cachedTokens: 40, reasoningTokens: 7 });
  });
});
