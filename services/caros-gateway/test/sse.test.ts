import { describe, it, expect } from "vitest";
import type { Response } from "express";
import { pipeSseAndCaptureUsage } from "../src/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function fakeRes() {
  let written = "";
  return {
    res: { write: (c: string) => ((written += c), true) } as unknown as Response,
    get written() {
      return written;
    },
  };
}

describe("T2.S pipeSseAndCaptureUsage", () => {
  it("T2.S1 forwards bytes and captures the final usage object", async () => {
    const r = fakeRes();
    const usage = await pipeSseAndCaptureUsage(
      streamOf([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
      r.res,
    );
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(r.written).toContain('"content":"hi"');
    expect(r.written).toContain("[DONE]");
  });

  it("T2.S2 reassembles a usage line split across two reads", async () => {
    const r = fakeRes();
    const usage = await pipeSseAndCaptureUsage(
      streamOf(['data: {"choices":[],"usa', 'ge":{"total_tokens":9}}\n\n', "data: [DONE]\n\n"]),
      r.res,
    );
    expect(usage).toEqual({ total_tokens: 9 });
  });

  it("T2.S3 ignores keepalive / non-JSON data lines", async () => {
    const r = fakeRes();
    const usage = await pipeSseAndCaptureUsage(
      streamOf([": keepalive\n\n", "data: not-json\n\n", 'data: {"choices":[{"delta":{}}]}\n\n']),
      r.res,
    );
    expect(usage).toBeUndefined();
    expect(r.written).toContain("keepalive");
  });
});
