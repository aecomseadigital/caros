import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export type AoaiAuthMode = "managed_identity" | "api_key";
export type Tier = "mini" | "nano";

export const config = {
  port: parseInt(optional("PORT", "80"), 10),
  aoai: {
    endpoint: required("AOAI_ENDPOINT").replace(/\/+$/, ""),
    apiVersion: optional("AOAI_API_VERSION", "2025-04-01-preview"),
    authMode: optional("AOAI_AUTH_MODE", "managed_identity") as AoaiAuthMode,
    apiKey: optional("AZURE_OPENAI_API_KEY", ""),
    miScope: optional("AOAI_MI_SCOPE", "https://cognitiveservices.azure.com/.default"),
    deployments: {
      mini: optional("AOAI_DEPLOYMENT_MINI", "gpt-5.4-mini"),
      nano: optional("AOAI_DEPLOYMENT_NANO", "gpt-5.4-nano"),
    } satisfies Record<Tier, string>,
  },
  classifier: {
    nanoFallback: optional("CLASSIFIER_NANO_FALLBACK", "true") === "true",
    largeTokenThreshold: parseInt(optional("CLASSIFIER_LARGE_TOKENS", "6000"), 10),
  },
  sharedSecret: optional("GATEWAY_SHARED_SECRET", ""),
  appInsightsConnectionString: optional("APPLICATIONINSIGHTS_CONNECTION_STRING", ""),
  headers: {
    secret: optional("GATEWAY_SECRET_HEADER", "x-gateway-secret"),
    userOid: optional("USER_OID_HEADER", "x-user-oid"),
    userUpn: optional("USER_UPN_HEADER", "x-user-upn"),
  },
};

export function deploymentFor(tier: Tier): string {
  return config.aoai.deployments[tier];
}
