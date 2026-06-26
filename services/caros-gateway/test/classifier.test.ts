import { describe, it, expect, afterEach } from "vitest";
import { heuristicTier, concatMessages, classify, hasImageContent, ensureImageDetailHigh } from "../src/classifier";
import { config } from "../src/config";

function body(messages: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { messages, ...extra };
}
const userMsg = (text: string) => [{ role: "user", content: text }];

describe("T1.A heuristicTier", () => {
  it("T1.A1 tools present -> mini", () => {
    expect(heuristicTier(body(userMsg("hi"), { tools: [{ type: "function" }] }))).toEqual({
      tier: "mini",
      reason: "tools_present",
    });
  });

  it("T1.A2 tool_choice auto -> mini, none -> falls through", () => {
    expect(heuristicTier(body(userMsg("hi"), { tool_choice: "auto" }))).toEqual({
      tier: "mini",
      reason: "tool_choice",
    });
    expect(heuristicTier(body(userMsg("hi"), { tool_choice: "none" }))).toEqual({
      tier: "nano",
      reason: "short_simple",
    });
  });

  it("T1.A3 code fence -> mini", () => {
    expect(heuristicTier(body(userMsg("```js\nconst x = 1\n```")))?.reason).toBe("code_detected");
  });

  it("T1.A4 reasoning keyword -> mini", () => {
    expect(heuristicTier(body(userMsg("please refactor this and walk me through the stack trace")))).toEqual({
      tier: "mini",
      reason: "reasoning_detected",
    });
  });

  it("T1.A5 large context -> mini", () => {
    const big = ("alpha ".repeat(config.classifier.largeTokenThreshold)).trim();
    expect(heuristicTier(body(userMsg(big)))).toEqual({ tier: "mini", reason: "large_context" });
  });

  it("T1.A6 short simple -> nano", () => {
    expect(heuristicTier(body(userMsg("what is the capital of France?")))).toEqual({
      tier: "nano",
      reason: "short_simple",
    });
  });

  it("T1.A7 ambiguous mid-length -> null", () => {
    const mid = "alpha ".repeat(2500); // ~3750 tokens: above 1500, below default 6000
    expect(heuristicTier(body(userMsg(mid)))).toBeNull();
  });
});

describe("T1.A10 vision/image routing (WS5)", () => {
  const imageMsg = [
    {
      role: "user",
      content: [
        { type: "text", text: "what does this say?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ];

  it("image_url content -> mini / image_present", () => {
    expect(heuristicTier(body(imageMsg))).toEqual({ tier: "mini", reason: "image_present" });
  });

  it("hasImageContent detects / rejects", () => {
    expect(hasImageContent(imageMsg)).toBe(true);
    expect(hasImageContent(userMsg("just text"))).toBe(false);
    expect(hasImageContent(undefined)).toBe(false);
  });

  it("ensureImageDetailHigh forces detail:high only when omitted", () => {
    const out = ensureImageDetailHigh(imageMsg) as typeof imageMsg;
    const block = out[0]!.content[1] as { image_url: { detail?: string } };
    expect(block.image_url.detail).toBe("high");

    const explicit = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "x", detail: "low" } }] },
    ];
    const kept = ensureImageDetailHigh(explicit) as typeof explicit;
    expect((kept[0]!.content[0] as { image_url: { detail: string } }).image_url.detail).toBe("low");
  });
});

describe("T1.A8/9 concatMessages", () => {
  it("T1.A8 flattens array content text blocks, ignores non-text", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "x" } }] },
      { role: "assistant", content: "world" },
    ];
    expect(concatMessages(msgs)).toContain("hello");
    expect(concatMessages(msgs)).toContain("world");
  });

  it("T1.A9 non-array -> empty string", () => {
    expect(concatMessages(undefined)).toBe("");
    expect(concatMessages("nope")).toBe("");
  });
});

describe("T1.A7 classify with nanoFallback disabled (no network)", () => {
  const original = config.classifier.nanoFallback;
  afterEach(() => {
    config.classifier.nanoFallback = original;
  });

  it("ambiguous + fallback off -> default_nano without calling AOAI", async () => {
    config.classifier.nanoFallback = false;
    const mid = "alpha ".repeat(2500);
    await expect(classify(body(userMsg(mid)))).resolves.toEqual({ tier: "nano", reason: "default_nano" });
  });
});
