import { config, type Tier } from "./config";
import { callChatCompletions } from "./aoai";

export interface ClassifyResult {
  tier: Tier;
  reason: string;
}

const CODE_HINT =
  /```|\b(function|class|def |import |const |let |async |await|public |private |interface |struct |impl |SELECT |#include|=>|console\.|System\.)\b/;
const REASONING_HINT =
  /\b(prove|derive|algorithm|complexity|optimi[sz]e|step[- ]by[- ]step|reason through|debug|refactor|stack trace|exception|traceback)\b/i;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

export function concatMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return (messages as ChatMessage[])
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text?: unknown }).text ?? "") : ""))
          .join(" ");
      }
      return "";
    })
    .join("\n");
}

/** True if any message carries an `image_url` content block (vision / OCR request). */
export function hasImageContent(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return (messages as ChatMessage[]).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((c) => c != null && typeof c === "object" && (c as { type?: unknown }).type === "image_url"),
  );
}

/**
 * Force `detail: "high"` on every image_url block that omits it. Low detail
 * flattens images to a ~85-token tile and corrupts fine text (OCR is the dominant
 * use case), so the gateway never lets a caller silently get low-detail vision.
 */
export function ensureImageDetailHigh(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return (messages as ChatMessage[]).map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((c) => {
        if (c != null && typeof c === "object" && (c as { type?: unknown }).type === "image_url") {
          const iu = (c as { image_url?: Record<string, unknown> }).image_url;
          if (iu && typeof iu === "object" && iu.detail === undefined) {
            return { ...c, image_url: { ...iu, detail: "high" } };
          }
        }
        return c;
      }),
    };
  });
}

/** Fast, zero-cost routing. Returns null when the request is genuinely ambiguous. */
export function heuristicTier(body: Record<string, unknown>): ClassifyResult | null {
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) return { tier: "mini", reason: "tools_present" };
  if (body.tool_choice && body.tool_choice !== "none") return { tier: "mini", reason: "tool_choice" };

  // Vision/OCR: route to mini for fidelity headroom on noisy real-world screenshots.
  if (hasImageContent(body.messages)) return { tier: "mini", reason: "image_present" };

  const text = concatMessages(body.messages);
  if (CODE_HINT.test(text)) return { tier: "mini", reason: "code_detected" };
  if (REASONING_HINT.test(text)) return { tier: "mini", reason: "reasoning_detected" };

  const tokens = estimateTokens(text);
  if (tokens > config.classifier.largeTokenThreshold) return { tier: "mini", reason: "large_context" };
  if (tokens < 1500) return { tier: "nano", reason: "short_simple" };

  return null;
}

export async function classify(body: Record<string, unknown>): Promise<ClassifyResult> {
  const fast = heuristicTier(body);
  if (fast) return fast;

  if (!config.classifier.nanoFallback) return { tier: "nano", reason: "default_nano" };

  try {
    return { tier: await nanoClassify(concatMessages(body.messages)), reason: "nano_classifier" };
  } catch {
    return { tier: "nano", reason: "classifier_error_default_nano" };
  }
}

async function nanoClassify(text: string): Promise<Tier> {
  const prompt =
    `Classify task complexity for model routing. Reply with exactly one word: ` +
    `"complex" if it needs careful coding, multi-step reasoning, or tool use; otherwise "simple".\n\n` +
    `Task:\n${text.slice(0, 4000)}`;

  const res = await callChatCompletions(config.aoai.deployments.nano, {
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 4,
  });
  if (!res.ok) throw new Error(`nano classify failed: ${res.status}`);

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const answer = (json.choices?.[0]?.message?.content ?? "").toLowerCase();
  return answer.includes("complex") ? "mini" : "nano";
}
