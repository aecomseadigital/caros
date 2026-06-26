// Runs before any test module imports `src/config.ts`, which reads required
// env vars at import time. Provides hermetic defaults so no real Azure is needed.
process.env.AOAI_ENDPOINT ??= "https://test-aoai.openai.azure.com";
process.env.AOAI_API_VERSION ??= "2025-04-01-preview";
process.env.AOAI_AUTH_MODE ??= "api_key";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.AOAI_DEPLOYMENT_MINI ??= "gpt-5.4-mini";
process.env.AOAI_DEPLOYMENT_NANO ??= "gpt-5.4-nano";
process.env.GATEWAY_SHARED_SECRET ??= "";
// Hermetic tests emulate local dev (no secret); the fail-closed path is tested explicitly.
process.env.ALLOW_INSECURE_NO_SECRET ??= "true";
process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ??= "";
