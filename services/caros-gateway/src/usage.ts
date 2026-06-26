import * as appInsights from "applicationinsights";
import { config, type Tier } from "./config";
import type { CallerIdentity } from "./auth";

export interface AoaiUsage {
  // Chat Completions shape
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  // Responses API shape (top-level counts are named input_/output_tokens)
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/** Collapse the chat-completions and responses usage shapes into one set of counts. */
export function normalizeUsage(u?: AoaiUsage): NormalizedUsage {
  const promptTokens = u?.prompt_tokens ?? u?.input_tokens ?? 0;
  const completionTokens = u?.completion_tokens ?? u?.output_tokens ?? 0;
  const cachedTokens =
    u?.prompt_tokens_details?.cached_tokens ?? u?.input_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens =
    u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u?.total_tokens ?? promptTokens + completionTokens,
    cachedTokens,
    reasoningTokens,
  };
}

export interface UsageEvent {
  caller: CallerIdentity;
  deployment: string;
  tier: Tier;
  reason: string;
  stream: boolean;
  latencyMs: number;
  usage?: AoaiUsage;
}

let client: appInsights.TelemetryClient | undefined;

export function initTelemetry(): void {
  if (!config.appInsightsConnectionString) {
    console.warn("[caros-gateway] APPLICATIONINSIGHTS_CONNECTION_STRING not set — usage logged to stdout only");
    return;
  }
  appInsights
    .setup(config.appInsightsConnectionString)
    .setAutoCollectConsole(false)
    .setSendLiveMetrics(false)
    .start();
  client = appInsights.defaultClient;
}

export function logUsage(e: UsageEvent): void {
  const properties: Record<string, string> = {
    oid: e.caller.oid,
    upn: e.caller.upn,
    deployment: e.deployment,
    tier: e.tier,
    reason: e.reason,
    stream: String(e.stream),
  };
  const n = normalizeUsage(e.usage);
  const measurements: Record<string, number> = {
    promptTokens: n.promptTokens,
    completionTokens: n.completionTokens,
    totalTokens: n.totalTokens,
    cachedTokens: n.cachedTokens,
    reasoningTokens: n.reasoningTokens,
    cachedFrac: n.promptTokens > 0 ? n.cachedTokens / n.promptTokens : 0,
    latencyMs: e.latencyMs,
  };

  client?.trackEvent({ name: "CarosUsage", properties, measurements });
  console.log(JSON.stringify({ evt: "CarosUsage", ...properties, ...measurements }));
}
