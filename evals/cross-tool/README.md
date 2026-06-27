# Cross-Tool Benchmark — Oscar vs. Copilot Chat (Basic) vs. Caros

A lean, automated harness that compares three assistants on **accuracy**, **response
time**, and (where measurable) **cost**, then produces an **executive decision report**.

- **Oscar** — internal corporate web chatbot (RAG; web UI only).
- **Microsoft Copilot Chat (Basic)** — free M365 Copilot Chat (web UI only).
- **Caros** — this repo's agentic CLI (`caros run`, scriptable).

> Full methodology and rationale: `../../../CAROS_PLAN.md` is unrelated; the study
> plan lives at the approved plan doc referenced by the team. This README is the
> **runbook** for operators.

---

## ⛔ Read before running — two hard guardrails

These are enforced in code (`providers/lib/policy.js`), not just documented.

1. **Data policy — public/synthetic data only.** Copilot Chat *Basic/free* may lack
   Enterprise/Commercial Data Protection, so prompts can leave the tenant or be
   retained. **Never** put real confidential corporate documents into any prompt.
   Every dataset row must carry `"data_class": "public"` or `"synthetic"`; the
   harness refuses to send anything else to a web target.

2. **Copilot automation is gated.** Automating Microsoft Copilot may breach
   acceptable-use terms and risk the account. The Copilot provider **throws unless
   `ALLOW_COPILOT=1` is set AND `.auth/copilot.consent` exists** (a file you create
   only after manager/IT sign-off). Use a **dedicated, non-privileged test account**,
   human-like pacing, low concurrency, off-hours, and keep the audit log.

---

## Architecture

```
promptfooconfig.yaml         # orchestration: 3 providers × shared prompts × graders
providers/
  caros.js                   # exec adapter → `caros run` (parses session jsonl)
  oscar.js                   # Playwright adapter → Oscar web UI
  copilot.js                 # Playwright adapter → Copilot web UI (gated)
  lib/browser.js             # shared submit + TTFT/total capture
  lib/policy.js              # data-class + Copilot-consent guardrails
datasets/
  fetch_datasets.py          # pull + subset open suites from HuggingFace
  sample/*.jsonl             # tiny committed sets for offline smoke tests
judge/rubrics/*.md           # LLM-judge prompts (bias controls baked in)
report/aggregate.mjs         # promptfoo output → executive markdown report
```

The four **scenario tracks** and their suites (only what fits — see plan):

| Track | Suite(s) | Grading | Comparable? |
|---|---|---|---|
| `qa` | SimpleQA, IFEval | auto-grader (IFEval) + SimpleQA grader | like-for-like |
| `rag` | FRAMES (+ source passages in-prompt), RAGAS metrics | LLM judge (faithfulness/relevancy) | like-for-like |
| `reasoning` | GPQA-Diamond, BBH subset | multiple-choice exact match | like-for-like |
| `coding` | SWE-bench Verified subset, GAIA L1 | execution (Caros) / judged code (web tools) | **Caros differentiation** |

---

## Setup

```bash
# 1. Node deps + Chromium
npm install
npm run browsers

# 2. Build the Caros release binary (from the goose workspace root)
#    source bin/activate-hermit && cargo build --release   → target/release/caros
#    then point CAROS_BIN at it (see .env.example)

# 3. Datasets (needs Python + `pip install datasets`)
python datasets/fetch_datasets.py --n 120          # ~120 items/track into datasets/<track>/

# 4. Auth (one-time, interactive — saves storageState under .auth/)
node providers/lib/browser.js --login oscar        # opens a browser, you sign in
node providers/lib/browser.js --login copilot       # only after sign-off

# 4b. After auth, discover/fill selectors, then smoke the web adapter
node scripts/discover_selectors.mjs oscar       # optional helper if codegen output is unclear
node scripts/web_smoke.mjs oscar
node scripts/web_smoke.mjs copilot              # requires ALLOW_COPILOT=1 + .auth/copilot.consent

# 5. Judge key — set an independent (Claude-family) judge in .env
```

Copy `.env.example` → `.env` and fill in:

```
CAROS_BIN=../../target/release/caros
OSCAR_URL=https://oscar.aecom.global/home
COPILOT_URL=https://m365.cloud.microsoft/chat
ANTHROPIC_API_KEY=...          # judge model (different family from targets)
ALLOW_COPILOT=                  # set to 1 only after creating .auth/copilot.consent
```

---

## Run

```bash
# Offline smoke test (committed sample data; Caros only, no web targets)
npx promptfoo eval -c promptfooconfig.yaml --filter-providers caros --tests datasets/sample/qa.jsonl

# One track, all three targets, interleaved, 5 reps for latency
npm run eval -- --vars datasets/qa/qa.jsonl --repeat 5

# Full curated run (all tracks)
npm run eval

# Inspect side-by-side
npm run view

# Generate the executive report
npm run report          # → output/executive-report.md
```

---

## Metrics

- **Accuracy** — per-track; never blended. Auto-grader where possible; LLM judge
  (Claude-family, order-swapped, verbosity-guarded) only for open-ended items.
- **Latency** — `ttftMs` (time to first token) and `totalMs` (wall-clock) captured
  separately per item; report **median ± IQR** over `--repeat` reps; web UIs include
  render/network the CLI does not. Caros records which deployment (`mini`/`nano`)
  served each request (`x-caros-deployment`).
- **Cost** — Caros: tokens × AOAI rate (from session jsonl). Copilot Basic: free at
  point of use. Oscar: typically opaque → reported as unknown.

---

## Verify the harness before trusting numbers

1. Per-adapter smoke (1 fixed prompt each) — Caros returns + jsonl parses; Oscar/Copilot
   capture text + timestamps.
2. Auto-grader check — IFEval + one GPQA item match the official scorer.
3. Judge calibration — 5–10 open-ended items judged twice with A/B swapped; confirm
   self-consistency + human agreement on a spot-check.
4. Latency sanity — `ttftMs ≤ totalMs`; Caros lowest, web UIs higher.
5. Reuse check — `../open-model-gym` (`just test`) and `../harbor` still run on the
   current Caros build for the agentic track.

Only scale to the full run after 1–5 pass.
