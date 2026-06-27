// Hard guardrails, enforced at the provider boundary (not just docs).
// See README "Read before running".
import { existsSync } from 'node:fs';

const ALLOWED_WEB_DATA_CLASSES = new Set(['public', 'synthetic']);

/**
 * Refuse to send anything that isn't explicitly public/synthetic to a web target.
 * Copilot Basic may lack Enterprise/Commercial Data Protection, so confidential
 * content could leave the tenant. Throwing here fails the row safely.
 */
export function assertWebDataClass(vars, targetLabel) {
  const cls = vars && vars.data_class;
  if (!ALLOWED_WEB_DATA_CLASSES.has(cls)) {
    throw new Error(
      `[policy] Refusing to send to ${targetLabel}: row data_class=${JSON.stringify(cls)} ` +
        `is not public/synthetic. Only public or synthetic data may reach web targets.`,
    );
  }
}

/**
 * Copilot automation gate. Requires BOTH an explicit env opt-in AND a consent file
 * that an operator creates only after manager/IT sign-off.
 */
export function assertCopilotConsent() {
  const consentFile = '.auth/copilot.consent';
  if (process.env.ALLOW_COPILOT !== '1' || !existsSync(consentFile)) {
    throw new Error(
      '[policy] Copilot automation is gated. Set ALLOW_COPILOT=1 AND create ' +
        `${consentFile} (only after manager/IT sign-off). Refusing to run.`,
    );
  }
}

/** Human-like pacing between web requests to respect rate limits / acceptable use. */
export function humanPace(ms = 2500) {
  return new Promise((r) => setTimeout(r, ms));
}
