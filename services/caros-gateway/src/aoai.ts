import { DefaultAzureCredential, type AccessToken } from "@azure/identity";
import { config } from "./config";

let credential: DefaultAzureCredential | undefined;
let cachedToken: AccessToken | null = null;

async function getBearerToken(): Promise<string> {
  if (!credential) credential = new DefaultAzureCredential();
  const now = Date.now();
  if (!cachedToken || cachedToken.expiresOnTimestamp - now < 60_000) {
    cachedToken = await credential.getToken(config.aoai.miScope);
    if (!cachedToken) throw new Error("Failed to acquire Azure OpenAI token via managed identity");
  }
  return cachedToken.token;
}

export async function aoaiAuthHeaders(): Promise<Record<string, string>> {
  if (config.aoai.authMode === "api_key") {
    if (!config.aoai.apiKey) {
      throw new Error("AOAI_AUTH_MODE=api_key but AZURE_OPENAI_API_KEY is not set");
    }
    return { "api-key": config.aoai.apiKey };
  }
  return { Authorization: `Bearer ${await getBearerToken()}` };
}

export function chatCompletionsUrl(deployment: string): string {
  return `${config.aoai.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${config.aoai.apiVersion}`;
}

export async function callChatCompletions(deployment: string, body: unknown): Promise<Response> {
  const headers = { "Content-Type": "application/json", ...(await aoaiAuthHeaders()) };
  return fetch(chatCompletionsUrl(deployment), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
