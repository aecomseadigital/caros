#!/usr/bin/env node
// promptfoo results.json → executive markdown report.
// Per provider × track: accuracy, latency (median ± IQR for ttft and total), tokens.
// Deliberately never blends tracks into one score (see plan: fairness).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const IN = process.argv[2] || 'output/results.json';
const OUT = process.argv[3] || 'output/executive-report.md';

const data = JSON.parse(readFileSync(IN, 'utf8'));
const rows = data?.results?.results ?? data?.results ?? [];
if (!Array.isArray(rows) || rows.length === 0) {
  console.error(`No results in ${IN}. Run an eval first.`);
  process.exit(1);
}

const TRACKS = ['qa', 'rag', 'reasoning', 'coding'];
const LABELS = { qa: 'Factual Q&A', rag: 'Summarization & RAG', reasoning: 'Reasoning', coding: 'Coding & agentic (Caros differentiation)' };

// group[provider][track] = { n, pass, ttft[], total[], tokens[] }
const group = {};
for (const r of rows) {
  const provider = r.provider?.label || r.provider?.id || r.provider || 'unknown';
  const vars = r.vars || r.testCase?.vars || {};
  const track = vars.track || 'qa';
  const meta = r.response?.metadata || {};
  const g = ((group[provider] ??= {})[track] ??= { n: 0, pass: 0, ttft: [], total: [], tokens: [] });
  g.n++;
  if (r.success) g.pass++;
  if (Number.isFinite(meta.ttftMs)) g.ttft.push(meta.ttftMs);
  const total = Number.isFinite(meta.totalMs) ? meta.totalMs : r.latencyMs;
  if (Number.isFinite(total)) g.total.push(total);
  const tok = r.response?.tokenUsage?.total;
  if (Number.isFinite(tok)) g.tokens.push(tok);
}

const providers = Object.keys(group);
const fmtMs = (xs) => (xs.length ? `${Math.round(median(xs))} ± ${Math.round(iqr(xs))}` : '—');
const pct = (g) => (g.n ? `${((g.pass / g.n) * 100).toFixed(0)}%` : '—');

let md = `# Executive comparison — Oscar vs. Copilot Chat (Basic) vs. Caros\n\n`;
md += `_Generated from \`${IN}\`. Scores are per-track and must not be blended into a single number (the tools are architecturally different)._\n\n`;

md += `## Accuracy by track (% pass, n)\n\n`;
md += `| Track | ${providers.join(' | ')} |\n|${'---|'.repeat(providers.length + 1)}\n`;
for (const t of TRACKS) {
  const cells = providers.map((p) => {
    const g = group[p]?.[t];
    return g ? `${pct(g)} (n=${g.n})` : '—';
  });
  md += `| ${LABELS[t]} | ${cells.join(' | ')} |\n`;
}

md += `\n## Response time — total wall-clock ms (median ± IQR)\n\n`;
md += `| Track | ${providers.join(' | ')} |\n|${'---|'.repeat(providers.length + 1)}\n`;
for (const t of TRACKS) {
  const cells = providers.map((p) => fmtMs(group[p]?.[t]?.total ?? []));
  md += `| ${LABELS[t]} | ${cells.join(' | ')} |\n`;
}

md += `\n## Time to first token — ms (median ± IQR)\n\n`;
md += `| Track | ${providers.join(' | ')} |\n|${'---|'.repeat(providers.length + 1)}\n`;
for (const t of TRACKS) {
  const cells = providers.map((p) => fmtMs(group[p]?.[t]?.ttft ?? []));
  md += `| ${LABELS[t]} | ${cells.join(' | ')} |\n`;
}

md += `\n## Cost proxy — Caros tokens/req (median)\n\n`;
md += `Copilot Basic is free at point of use; Oscar's internal cost is opaque (reported unknown).\n\n`;
md += `| Track | Caros tokens (median) |\n|---|---|\n`;
for (const t of TRACKS) {
  const xs = group['Caros']?.[t]?.tokens ?? [];
  md += `| ${LABELS[t]} | ${xs.length ? Math.round(median(xs)) : '—'} |\n`;
}

md += `\n## Caveats\n`;
md += `- Per-track only; never a blended score. Coding/agentic is a Caros-differentiation track — web chat tools cannot execute or use tools.\n`;
md += `- Underlying models for Oscar/Copilot are opaque and may change; Caros routes mini/nano server-side. Results are a dated snapshot.\n`;
md += `- Web-UI latency includes render/network the CLI does not; compare within a track, not across interfaces naively.\n`;

mkdirSync(OUT.replace(/[^/\\]+$/, '') || '.', { recursive: true });
writeFileSync(OUT, md);
console.log(`Wrote ${OUT}`);

function median(xs) {
  return quantile(xs, 0.5);
}
function iqr(xs) {
  return quantile(xs, 0.75) - quantile(xs, 0.25);
}
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
