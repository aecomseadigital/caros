// Oscar target — Playwright adapter over the internal web UI.
// Internal/company-owned, so automation is fine; still public/synthetic data only.
import { askWebUI } from './lib/browser.js';
import { assertWebDataClass, humanPace } from './lib/policy.js';

export default class OscarProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'oscar';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const vars = (context && context.vars) || {};
    assertWebDataClass(vars, 'Oscar');

    try {
      const { text, ttftMs, totalMs } = await askWebUI({
        url: configuredValue(this.config.url, 'OSCAR_URL'),
        authState: this.config.authState || '.auth/oscar.json',
        selectors: this.config.selectors,
        prompt,
      });
      await humanPace(); // pace before the next row
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
