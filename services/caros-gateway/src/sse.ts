import type { Response } from "express";
import type { AoaiUsage } from "./usage";

/**
 * Forwards an Azure OpenAI SSE stream to the client byte-for-byte while sniffing
 * the final `usage` object (emitted when stream_options.include_usage is set).
 */
export async function pipeSseAndCaptureUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  res: Response,
): Promise<AoaiUsage | undefined> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: AoaiUsage | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);
    buffer += chunk;

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data) as { usage?: AoaiUsage };
        if (obj.usage) usage = obj.usage;
      } catch {
        // partial/non-JSON keepalive line — ignore
      }
    }
  }

  return usage;
}
