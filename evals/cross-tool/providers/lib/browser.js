// Shared Playwright driver for the web-UI targets (Oscar, Copilot).
//
// Captures TWO timings separately because web UIs include render/network the CLI
// does not: ttftMs (first visible assistant token) and totalMs (response stable).
//
// Selectors are passed in from promptfooconfig.yaml because the live DOM is only
// knowable on the operator's machine. Fill them in after `npx playwright codegen <url>`.
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertCopilotConsent } from './policy.js';

loadDotEnv();

const HEADLESS = process.env.HEADLESS === '1';

/**
 * Drive one prompt through a web chat UI and return text + timings.
 * @param {{url:string, authState:string, selectors:object, prompt:string,
 *          settleMs?:number, timeoutMs?:number}} opts
 * @returns {Promise<{text:string, ttftMs:number, totalMs:number}>}
 */
export async function askWebUI(opts) {
  const { url, authState, selectors, prompt } = opts;
  const settleMs = opts.settleMs ?? 1200; // text must be unchanged this long = done
  const timeoutMs = opts.timeoutMs ?? 120_000;

  validateUrl(url);
  validateSelectors(selectors);

  if (!existsSync(authState)) {
    throw new Error(
      `Auth state ${authState} missing. Run: node providers/lib/browser.js --login <oscar|copilot>`,
    );
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ storageState: authState });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const input = page.locator(selectors.input);
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.click();
    await input.fill(prompt);

    const turn = page.locator(selectors.assistantTurn).last();
    const before = await turn.count();

    const t0 = Date.now();
    if (selectors.send) await page.locator(selectors.send).click();
    else await input.press('Enter');

    // TTFT: first time a *new* assistant turn shows any text.
    let ttftMs = -1;
    await waitFor(async () => {
      const t = page.locator(selectors.assistantTurn);
      if ((await t.count()) <= before) return false;
      const txt = (await t.last().innerText().catch(() => '')) || '';
      if (txt.trim().length > 0) {
        ttftMs = Date.now() - t0;
        return true;
      }
      return false;
    }, timeoutMs);

    // Total: streaming indicator gone AND text stable for settleMs.
    let last = '';
    let lastChange = Date.now();
    await waitFor(async () => {
      const streaming = selectors.streaming
        ? await page.locator(selectors.streaming).count()
        : 0;
      const txt =
        (await page.locator(selectors.assistantTurn).last().innerText().catch(() => '')) || '';
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }
      return streaming === 0 && Date.now() - lastChange >= settleMs;
    }, timeoutMs);

    const totalMs = Date.now() - t0;
    return { text: last.trim(), ttftMs: ttftMs < 0 ? totalMs : ttftMs, totalMs };
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function validateUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`Missing or invalid web target URL: ${JSON.stringify(url)}`);
  }
}

function validateSelectors(selectors) {
  const required = ['input', 'assistantTurn'];
  for (const key of required) {
    const value = selectors && selectors[key];
    if (typeof value !== 'string' || !value.trim() || /^TODO\b/i.test(value.trim())) {
      throw new Error(
        `Missing selector '${key}'. Fill promptfooconfig.yaml selectors before running web adapters.`,
      );
    }
  }
  for (const key of ['send', 'streaming']) {
    const value = selectors && selectors[key];
    if (typeof value === 'string' && /^TODO\b/i.test(value.trim())) {
      throw new Error(
        `Placeholder selector '${key}' remains in promptfooconfig.yaml. Use '' if intentionally omitted.`,
      );
    }
  }
}

async function waitFor(predicate, timeoutMs, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for UI state`);
}

/** Interactive one-time login -> saves storageState for reuse. */
async function login(target) {
  if (target === 'copilot') assertCopilotConsent();

  const urls = { oscar: process.env.OSCAR_URL, copilot: process.env.COPILOT_URL };
  const url = urls[target];
  if (!url) throw new Error(`Unknown target '${target}' or missing ${target.toUpperCase()}_URL`);
  const out = `.auth/${target}.json`;
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  console.log(`\nSign in to ${target} in the opened window, then press Enter here to save...`);
  await new Promise((r) => process.stdin.once('data', r));
  await ctx.storageState({ path: out });
  console.log(`Saved ${out}`);
  await browser.close();
  process.exit(0);
}

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// CLI: node providers/lib/browser.js --login oscar
if (process.argv[2] === '--login') {
  login(process.argv[3]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}