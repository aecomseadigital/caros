#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import OscarProvider from '../providers/oscar.js';
import CopilotProvider from '../providers/copilot.js';

const target = (process.argv[2] || '').toLowerCase();
const prompt = process.argv.slice(3).join(' ') || 'Reply with exactly: ready';

const providers = {
  oscar: { label: 'Oscar', Provider: OscarProvider },
  copilot: { label: 'Copilot Chat (Basic)', Provider: CopilotProvider },
};

if (!providers[target]) {
  console.error('Usage: node scripts/web_smoke.mjs <oscar|copilot> [prompt]');
  process.exit(2);
}

const config = YAML.parse(readFileSync('promptfooconfig.yaml', 'utf8'));
const providerConfig = config.providers.find((p) => p.label === providers[target].label)?.config;
if (!providerConfig) throw new Error(`Provider config not found for ${providers[target].label}`);

const provider = new providers[target].Provider({ config: providerConfig, id: target });
const result = await provider.callApi(prompt, {
  vars: { prompt, track: 'qa', data_class: 'synthetic' },
});

if (result.error) throw new Error(result.error);
const text = String(result.output || '').trim();
const meta = result.metadata || {};
if (!text) throw new Error('Web adapter returned empty text');
if (!Number.isFinite(meta.ttftMs) || !Number.isFinite(meta.totalMs)) {
  throw new Error(`Missing timing metadata: ${JSON.stringify(meta)}`);
}
if (meta.ttftMs > meta.totalMs) {
  throw new Error(`Invalid timing metadata: ttftMs ${meta.ttftMs} > totalMs ${meta.totalMs}`);
}

console.log(
  JSON.stringify(
    {
      target,
      ttftMs: meta.ttftMs,
      totalMs: meta.totalMs,
      text: text.slice(0, 500),
    },
    null,
    2,
  ),
);