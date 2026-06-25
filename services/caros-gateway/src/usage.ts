import * as appInsights from "applicationinsights";
import { config, type Tier } from "./config";
import type { CallerIdentity } from "./auth";

export interface AoaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
  const measurements: Record<string, number> = {
    promptTokens: e.usage?.prompt_tokens ?? 0,
    completionTokens: e.usage?.completion_tokens ?? 0,
    totalTokens: e.usage?.total_tokens ?? 0,
    latencyMs: e.latencyMs,
  };

  client?.trackEvent({ name: "CarosUsage", properties, measurements });
  console.log(JSON.stringify({ evt: "CarosUsage", ...properties, ...measurements }));
}
