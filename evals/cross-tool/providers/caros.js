// Caros target - exec adapter over the scriptable CLI.
//   normal rows:  caros run -i - --quiet   (prompt on stdin)
//   agentic rows: caros run --recipe <vars.recipe> ...   (coding track)
//
// Returns text + ttftMs (first stdout byte) + totalMs (wall-clock). Token usage is
// parsed from Caros request jsonl logs when available (best-effort).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export default class CarosProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'caros';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const bin = configuredValue(this.config.bin, 'CAROS_BIN') || 'caros';
    const vars = (context && context.vars) || {};
    const extra = this.config.extraArgs || ['--quiet'];

    const args = vars.recipe
      ? ['run', '--recipe', vars.recipe, ...recipeParams(vars.params), ...extra]
      : ['run', '-i', '-', ...extra];

    const startUsageMtime = newestUsageMtime();
    const t0 = Date.now();
    let ttftMs = -1;
    let out = '';
    let err = '';

    const code = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: process.env });
      child.stdout.on('data', (d) => {
        if (ttftMs < 0) ttftMs = Date.now() - t0;
        out += d.toString();
      });
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', resolve);
      if (!vars.recipe) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });

    const totalMs = Date.now() - t0;
    if (code !== 0) {
      return { error: `caros exited ${code}: ${err.slice(-500)}` };
    }

    const usage = readRequestUsage(startUsageMtime);
    return {
      output: stripChrome(out),
      tokenUsage: usage.tokenUsage,
      metadata: {
        ttftMs: ttftMs < 0 ? totalMs : ttftMs,
        totalMs,
        deployment: usage.deployment,
        model: usage.model,
      },
    };
  }
}

function configuredValue(value, envName) {
  if (typeof value !== 'string' || value === '' || /^\$\{[^}]+\}$/.test(value)) {
    return process.env[envName];
  }
  return value;
}

function recipeParams(params) {
  if (!params) return [];
  return Object.entries(params).flatMap(([k, v]) => ['--params', `${k}=${v}`]);
}

// caros prints session chrome/banners; keep this conservative - strip obvious
// non-answer lines but never the model's content.
function stripChrome(s) {
  return s
    .split('\n')
    .filter((l) => !/^(starting session|logging to|working directory)/i.test(l.trim()))
    .join('\n')
    .trim();
}

function requestLogDirs() {
  const dirs = [];
  if (process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'Block', 'caros', 'data', 'logs'));
    dirs.push(join(process.env.APPDATA, 'Caros', 'data', 'logs'));
  }
  dirs.push(join(homedir(), '.config', 'caros', 'logs'));
  dirs.push(join(homedir(), '.config', 'caros', 'sessions'));
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

function newestUsageMtime() {
  return Math.max(
    0,
    ...requestLogDirs().flatMap((dir) => {
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => statSync(join(dir, f)).mtimeMs);
      } catch {
        return [];
      }
    }),
  );
}

function readRequestUsage(sinceMtime) {
  const files = requestLogDirs()
    .flatMap((dir) => {
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }));
      } catch {
        return [];
      }
    })
    .filter((x) => x.mtime > sinceMtime)
    .sort((a, b) => a.mtime - b.mtime);

  let prompt = 0;
  let completion = 0;
  let total = 0;
  let model;
  let deployment;

  for (const file of files) {
    const parsed = parseRequestLog(file.path);
    if (!parsed) continue;
    prompt += parsed.prompt;
    completion += parsed.completion;
    total += parsed.total;
    model = parsed.model || model;
    deployment = parsed.deployment || deployment;
  }

  const computedTotal = total || prompt + completion;
  return {
    model,
    deployment,
    tokenUsage: computedTotal ? { prompt, completion, total: computedTotal } : undefined,
  };
}

function parseRequestLog(path) {
  try {
    const events = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    if (!events.length || isTitleGeneration(events[0])) return undefined;

    let prompt = 0;
    let completion = 0;
    let total = 0;
    let deployment;
    const model = events[0].model_config?.model_name || events[0].input?.model;

    for (const ev of events) {
      const u = ev.usage || ev.data?.usage || ev.message?.usage;
      if (u) {
        prompt += num(u.input_tokens) || num(u.prompt_tokens);
        completion += num(u.output_tokens) || num(u.completion_tokens);
        total += num(u.total_tokens) || num(u.total);
      }
      deployment = findDeployment(ev) || deployment;
    }

    return { prompt, completion, total, model, deployment };
  } catch {
    return undefined;
  }
}

function isTitleGeneration(firstEvent) {
  const messages = firstEvent.input?.messages || [];
  return messages.some((m) => String(m.content || '').includes('Generate a short title'));
}

function findDeployment(ev) {
  return (
    ev.deployment ||
    ev.model_deployment ||
    ev.data?.deployment ||
    ev.data?.metadata?.deployment ||
    ev.data?.metadata?.['x-caros-deployment'] ||
    ev.headers?.['x-caros-deployment'] ||
    ev.response?.headers?.['x-caros-deployment']
  );
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}