#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { assertCopilotConsent } from '../providers/lib/policy.js';

loadDotEnv();

const target = (process.argv[2] || '').toLowerCase();
if (!['oscar', 'copilot'].includes(target)) {
  console.error('Usage: node scripts/discover_selectors.mjs <oscar|copilot>');
  process.exit(2);
}
if (target === 'copilot') assertCopilotConsent();

const config = YAML.parse(readFileSync('promptfooconfig.yaml', 'utf8'));
const label = target === 'oscar' ? 'Oscar' : 'Copilot Chat (Basic)';
const providerConfig = config.providers.find((p) => p.label === label)?.config;
if (!providerConfig) throw new Error(`Provider config not found for ${label}`);

const url = configuredValue(providerConfig.url, target === 'oscar' ? 'OSCAR_URL' : 'COPILOT_URL');
const authState = providerConfig.authState || `.auth/${target}.json`;
if (!existsSync(authState)) throw new Error(`Missing ${authState}. Run login first.`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: authState });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
console.log(`Opened ${target}. If the page is still loading or redirected, finish it in the browser.`);
console.log('Press Enter here to inspect the current page...');
await new Promise((r) => process.stdin.once('data', r));

const report = {
  target,
  url: page.url(),
  title: await page.title(),
  candidates: await collectCandidates(page),
  accessibility: flattenA11y(await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null)),
};

const out = `output/${target}-selector-candidates.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Wrote ${out}`);
console.log('Use stable role, aria-label, placeholder, data-testid, or id selectors in promptfooconfig.yaml.');
await browser.close();

async function collectCandidates(page) {
  return page.evaluate(() => {
    const selector = [
      'textarea',
      'input',
      '[contenteditable="true"]',
      'button',
      '[role="button"]',
      '[role="textbox"]',
      '[aria-label]',
      '[placeholder]',
      '[data-testid]',
      '[data-test-id]',
    ].join(',');
    return Array.from(document.querySelectorAll(selector))
      .slice(0, 250)
      .map((el) => {
        const attrs = {};
        for (const name of [
          'id',
          'name',
          'type',
          'role',
          'aria-label',
          'placeholder',
          'title',
          'data-testid',
          'data-test-id',
          'class',
        ]) {
          const value = el.getAttribute(name);
          if (value) attrs[name] = value;
        }
        return {
          tag: el.tagName.toLowerCase(),
          selectorHints: selectorHints(el),
          attrs,
          text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
        };
      });

    function selectorHints(el) {
      const hints = [];
      const esc = CSS.escape;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (testId) hints.push(`[data-testid="${testId}"]`, `[data-test-id="${testId}"]`);
      const id = el.id;
      if (id) hints.push(`#${esc(id)}`);
      const role = el.getAttribute('role');
      const label = el.getAttribute('aria-label');
      if (role && label) hints.push(`[role="${role}"][aria-label="${label}"]`);
      if (label) hints.push(`[aria-label="${label}"]`);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) hints.push(`${el.tagName.toLowerCase()}[placeholder="${placeholder}"]`);
      const name = el.getAttribute('name');
      if (name) hints.push(`${el.tagName.toLowerCase()}[name="${name}"]`);
      return hints;
    }
  });
}

function flattenA11y(node, out = []) {
  if (!node) return out;
  if (['textbox', 'button', 'combobox', 'link', 'paragraph', 'heading'].includes(node.role)) {
    out.push({ role: node.role, name: node.name, value: node.value });
  }
  for (const child of node.children || []) flattenA11y(child, out);
  return out.slice(0, 200);
}

function configuredValue(value, envName) {
  if (typeof value !== 'string' || value === '' || /^\$\{[^}]+\}$/.test(value)) {
    return process.env[envName];
  }
  return value;
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