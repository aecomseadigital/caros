# caros-gateway

The Caros LLM gateway — an OpenAI-compatible service that sits behind **Azure API Management** and in
front of **Azure OpenAI** (`caros`, westus). It does three jobs:

1. **Task classification + routing** — a hybrid classifier (fast heuristics, gpt-5.4-nano fallback) picks
   `gpt-5.4-mini` vs `gpt-5.4-nano` per request, and spills mini → nano on 429/TPM saturation.
2. **Per-user usage logging** — emits a `CarosUsage` event per call to Application Insights (oid, upn,
   deployment, tier, token counts, latency).
3. **Transparent OpenAI-compatible proxy** — `POST /chat/completions` (and `/v1/chat/completions`) with
   SSE streaming pass-through; the Caros client points its `caros` provider here.

```
Caros client → APIM (validate-jwt + Hackathon group + token-limit + inject secret/user) → caros-gateway → Azure OpenAI
```

## Request contract (what APIM must send)

The gateway trusts APIM to have already validated the Entra JWT. APIM's inbound policy must set:

| Header | Value | Purpose |
|---|---|---|
| `x-gateway-secret` | the `gateway-shared-secret` (Key Vault named value) | proves the caller is APIM (gateway rejects otherwise) |
| `x-user-oid` | `@(context.Request.Headers...)` from the JWT `oid` claim | per-user usage attribution |
| `x-user-upn` | from the JWT `upn`/`preferred_username` claim | per-user usage attribution |

Header names are configurable (`GATEWAY_SECRET_HEADER`, `USER_OID_HEADER`, `USER_UPN_HEADER`). If
`GATEWAY_SHARED_SECRET` is empty the secret check is skipped (local dev only).

## Configuration

Copy `.env.example` → `.env`. Key vars:

| Var | Default | Notes |
|---|---|---|
| `AOAI_ENDPOINT` | — (required) | `https://caros.openai.azure.com/` |
| `AOAI_API_VERSION` | `2025-04-01-preview` | must match what the gpt-5.4 deployments require |
| `AOAI_AUTH_MODE` | `managed_identity` | `managed_identity` (gateway MI) or `api_key` (fallback) |
| `AZURE_OPENAI_API_KEY` | — | only used when `AOAI_AUTH_MODE=api_key` |
| `AOAI_DEPLOYMENT_MINI` / `_NANO` | `gpt-5.4-mini` / `gpt-5.4-nano` | deployment names on `caros` |
| `CLASSIFIER_NANO_FALLBACK` | `true` | ask nano to classify when heuristics are uncertain |
| `CLASSIFIER_LARGE_TOKENS` | `6000` | est. token count above which a request routes to mini |
| `GATEWAY_SHARED_SECRET` | — | APIM-injected secret; empty = check disabled |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | usage logging target; empty = stdout only |

**Auth note:** with `managed_identity`, the gateway's container app MI needs `Cognitive Services OpenAI User`
on the `caros` AOAI account. If that role assignment is blocked (UAA pending), set `AOAI_AUTH_MODE=api_key`
and supply `AZURE_OPENAI_API_KEY` — no code change needed.

## Local development

```bash
npm install
cp .env.example .env   # fill AOAI_ENDPOINT (+ AZURE_OPENAI_API_KEY if using api_key locally)
npm run dev            # tsx watch on PORT (default 80; set PORT=8099 locally)
curl localhost:8099/healthz
```

## Build & deploy to Azure Container Apps (`caros-gateway`, westus)

```bash
npm run build                          # tsc -> dist/
# build & push image (ACR admin user creds or `az acr login` if you have AcrPush)
az acr login -n acrcaros
docker build -t acrcaros.azurecr.io/caros-gateway:latest .
docker push acrcaros.azurecr.io/caros-gateway:latest

# point the container app at the image (registry pull needs the MI AcrPull role or ACR admin creds)
az containerapp update -g rg-caros -n caros-gateway \
  --image acrcaros.azurecr.io/caros-gateway:latest \
  --set-env-vars AOAI_ENDPOINT=https://caros.openai.azure.com/ \
                 AOAI_API_VERSION=2025-04-01-preview \
                 APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights-conn \
                 GATEWAY_SHARED_SECRET=secretref:gateway-shared-secret
```

Set the container's `--target-port` to the gateway `PORT` (use `PORT=80` in the container, or set the
container app target port to whatever `PORT` you choose).

## Endpoints

- `GET /healthz` → `{ "status": "ok" }`
- `POST /chat/completions` and `POST /v1/chat/completions` → OpenAI-compatible chat completions (streaming
  and non-streaming). Response includes `x-caros-deployment` and `x-caros-route-reason` headers so you can
  see the routing decision.

## How routing works

`src/classifier.ts`:
- **Heuristics first:** tools/`tool_choice` present, code detected, reasoning keywords, or large context → `mini`;
  short/simple → `nano`.
- **Uncertain** (medium-size, no strong signal) → a 1-shot gpt-5.4-nano classification call (disable with
  `CLASSIFIER_NANO_FALLBACK=false`, which defaults uncertain → nano).
- **Spillover:** if `mini` returns 429, the request is retried on `nano`.
