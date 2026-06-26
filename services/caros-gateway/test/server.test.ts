import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the AOAI network boundary; keep the real url/auth helpers.
vi.mock("../src/aoai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/aoai")>();
  return { ...actual, callChatCompletions: vi.fn() };
});

import request from "supertest";
import { createServer } from "../src/server";
import { callChatCompletions } from "../src/aoai";
import { config } from "../src/config";

const mockCall = vi.mocked(callChatCompletions);
const app = createServer();

const jsonResp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const coding = "please write a python function: def foo(): pass";
const simple = "what is the capital of France?";

beforeEach(() => mockCall.mockReset());
afterEach(() => {
  config.sharedSecret = "";
  config.reasoning.mini = "";
  config.reasoning.nano = "";
  config.promptCacheKey = false;
  vi.restoreAllMocks();
});

describe("T2.G gateway server", () => {
  it("T2.G1 secret required, missing header -> 401", async () => {
    config.sharedSecret = "s3cr3t";
    const res = await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("caros_gateway");
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("T2.G2 simple prompt -> nano", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    const res = await request(app).post("/v1/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect(res.status).toBe(200);
    expect(res.headers["x-caros-deployment"]).toBe(config.aoai.deployments.nano);
    expect(res.headers["x-caros-route-reason"]).toBe("short_simple");
  });

  it("T2.G3 coding prompt -> mini", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    const res = await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: coding }] });
    expect(res.headers["x-caros-deployment"]).toBe(config.aoai.deployments.mini);
    expect(res.headers["x-caros-route-reason"]).toBe("code_detected");
  });

  it("T2.G4 mini 429 -> spills to nano", async () => {
    mockCall
      .mockResolvedValueOnce(jsonResp({ error: "rate" }, 429))
      .mockResolvedValueOnce(jsonResp({ choices: [], usage }));
    const res = await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: coding }] });
    expect(res.status).toBe(200);
    expect(res.headers["x-caros-deployment"]).toBe(config.aoai.deployments.nano);
    expect(res.headers["x-caros-route-reason"]).toContain("spill_nano");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it("T2.G4b spill is metered as the served tier (nano), not the classified tier", async () => {
    mockCall
      .mockResolvedValueOnce(jsonResp({ error: "rate" }, 429))
      .mockResolvedValueOnce(jsonResp({ choices: [], usage }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: coding }] });
    const logged = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("CarosUsage"));
    expect(JSON.parse(logged!)).toMatchObject({ deployment: config.aoai.deployments.nano, tier: "nano" });
  });

  it("T2.G11 image request -> mini and detail forced high upstream", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    const res = await request(app)
      .post("/chat/completions")
      .send({
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        ],
      });
    expect(res.headers["x-caros-deployment"]).toBe(config.aoai.deployments.mini);
    expect(res.headers["x-caros-route-reason"]).toBe("image_present");
    const sentBody = mockCall.mock.calls[0]![1] as { messages: Array<{ content: Array<{ image_url?: { detail?: string } }> }> };
    expect(sentBody.messages[0]!.content[0]!.image_url!.detail).toBe("high");
  });

  it("T2.G5 streaming -> SSE passthrough with usage capture", async () => {
    mockCall.mockResolvedValue(
      new Response(
        streamOf([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[],"usage":{"total_tokens":5}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
    );
    const res = await request(app)
      .post("/chat/completions")
      .send({ stream: true, messages: [{ role: "user", content: simple }] });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"content":"hi"');
    expect(res.text).toContain("[DONE]");
  });

  it("T2.G7 upstream throws -> 502", async () => {
    mockCall.mockRejectedValue(new Error("ECONNRESET"));
    const res = await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain("upstream call failed");
  });

  it("T2.G8 healthz", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("T2.G9 strips client `model` from the upstream body", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app)
      .post("/chat/completions")
      .send({ model: "client-picked", messages: [{ role: "user", content: simple }] });
    const sentBody = mockCall.mock.calls[0]![1] as Record<string, unknown>;
    expect(sentBody.model).toBeUndefined();
  });

  it("T2.G10 propagates x-user-oid into the usage log", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await request(app)
      .post("/chat/completions")
      .set("x-user-oid", "user-42")
      .set("x-user-upn", "u@x.com")
      .send({ messages: [{ role: "user", content: simple }] });
    const logged = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("CarosUsage"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ oid: "user-42", upn: "u@x.com" });
  });

  it("T2.G12 injects the per-tier reasoning_effort floor when the caller omitted it", async () => {
    config.reasoning.nano = "low";
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect((mockCall.mock.calls[0]![1] as Record<string, unknown>).reasoning_effort).toBe("low");
  });

  it("T2.G12b preserves a caller-specified reasoning_effort", async () => {
    config.reasoning.nano = "low";
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app)
      .post("/chat/completions")
      .send({ reasoning_effort: "high", messages: [{ role: "user", content: simple }] });
    expect((mockCall.mock.calls[0]![1] as Record<string, unknown>).reasoning_effort).toBe("high");
  });

  it("T2.G12c leaves reasoning_effort unset when no floor is configured", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect((mockCall.mock.calls[0]![1] as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it("T2.G13 sets prompt_cache_key=<oid>:<tier> when enabled", async () => {
    config.promptCacheKey = true;
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app)
      .post("/chat/completions")
      .set("x-user-oid", "user-42")
      .send({ messages: [{ role: "user", content: simple }] });
    expect((mockCall.mock.calls[0]![1] as Record<string, unknown>).prompt_cache_key).toBe("user-42:nano");
  });

  it("T2.G13b leaves prompt_cache_key unset by default", async () => {
    mockCall.mockResolvedValue(jsonResp({ choices: [], usage }));
    await request(app).post("/chat/completions").send({ messages: [{ role: "user", content: simple }] });
    expect((mockCall.mock.calls[0]![1] as Record<string, unknown>).prompt_cache_key).toBeUndefined();
  });
});
