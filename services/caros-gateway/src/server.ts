import express, { type Request, type Response } from "express";
import { config, deploymentFor } from "./config";
import { getCaller, verifySharedSecret } from "./auth";
import { classify, ensureImageDetailHigh, hasImageContent } from "./classifier";
import { callChatCompletions } from "./aoai";
import { pipeSseAndCaptureUsage } from "./sse";
import { logUsage, type AoaiUsage } from "./usage";

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.post(["/chat/completions", "/v1/chat/completions"], handleChatCompletions);

  return app;
}

async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  if (!verifySharedSecret(req)) {
    res.status(401).json({ error: { message: "unauthorized", type: "caros_gateway" } });
    return;
  }

  const caller = getCaller(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const started = Date.now();

  const { tier, reason } = await classify(body);
  let deployment = deploymentFor(tier);
  let servedTier = tier;
  let routeReason = reason;

  const wantStream = body.stream === true;
  const outBody: Record<string, unknown> = { ...body };
  delete outBody.model; // Azure selects the model via the deployment in the URL
  if (hasImageContent(body.messages)) {
    outBody.messages = ensureImageDetailHigh(body.messages); // never silently send low-detail vision
  }
  if (wantStream) {
    outBody.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
  }

  let upstream: globalThis.Response;
  try {
    upstream = await callChatCompletions(deployment, outBody);
    if (upstream.status === 429 && tier === "mini") {
      deployment = config.aoai.deployments.nano; // spill mini -> nano on rate limit
      servedTier = "nano";
      routeReason = `${reason}+spill_nano`;
      upstream = await callChatCompletions(deployment, outBody);
    }
  } catch (err) {
    res.status(502).json({ error: { message: `upstream call failed: ${(err as Error).message}`, type: "caros_gateway" } });
    return;
  }

  res.setHeader("x-caros-deployment", deployment);
  res.setHeader("x-caros-route-reason", routeReason);

  if (wantStream && upstream.body) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.status(upstream.status);
    const usage = await pipeSseAndCaptureUsage(upstream.body, res);
    res.end();
    logUsage({ caller, deployment, tier: servedTier, reason: routeReason, stream: true, latencyMs: Date.now() - started, usage });
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status).type("application/json").send(text);
  let usage: AoaiUsage | undefined;
  try {
    usage = (JSON.parse(text) as { usage?: AoaiUsage }).usage;
  } catch {
    // non-JSON error body — leave usage undefined
  }
  logUsage({ caller, deployment, tier: servedTier, reason: routeReason, stream: false, latencyMs: Date.now() - started, usage });
}
