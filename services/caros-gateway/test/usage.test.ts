import { describe, it, expect, vi, afterEach } from "vitest";
import { logUsage } from "../src/usage";

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
      ["completionTokens", "deployment", "evt", "latencyMs", "oid", "promptTokens", "reason", "stream", "tier", "totalTokens", "upn"].sort(),
    );
  });
});
