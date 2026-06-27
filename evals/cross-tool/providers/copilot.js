// Microsoft Copilot Chat (Basic) target — Playwright adapter.
// GATED: refuses to run without ALLOW_COPILOT=1 + .auth/copilot.consent (sign-off).
// See providers/lib/policy.js and the README guardrails.
import { askWebUI } from './lib/browser.js';
import { assertWebDataClass, assertCopilotConsent, humanPace } from './lib/policy.js';

export default class CopilotProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'copilot';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const vars = (context && context.vars) || {};
    assertCopilotConsent(); // throws unless signed off
    assertWebDataClass(vars, 'Copilot Chat (Basic)');

    try {
      const { text, ttftMs, totalMs } = await askWebUI({
        url: configuredValue(this.config.url, 'COPILOT_URL'),
        authState: this.config.authState || '.auth/copilot.json',
        selectors: this.config.selectors,
        prompt,
      });
      await humanPace(4000); // extra-conservative pacing for Copilot
      return { output: text, metadata: { ttftMs, totalMs } };
    } catch (e) {
      return { error: String(e && e.message ? e.message : e) };
    }
  }
}

function configuredValue(value, envName) {
  if (typeof value !== 'string' || value === '' || /^\$\{[^}]+\}$/.test(value)) {
    return process.env[envName];
  }
  return value;
}
