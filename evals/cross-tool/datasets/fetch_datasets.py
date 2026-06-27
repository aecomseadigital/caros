#!/usr/bin/env python3
"""Pull and subset open benchmark suites into promptfoo test files (one per track).

Each output row is a promptfoo test case:
    {"description": "...", "vars": {...}, "assert": [...]}

Grading is chosen per suite so it never depends on a judge when it doesn't have to:
  - multiple-choice (GPQA, MMLU-Pro)  -> inline `javascript` exact letter match
  - open-ended factual / RAG          -> `llm-rubric` (routes to the independent judge)

Usage:
    pip install datasets
    python datasets/fetch_datasets.py --n 120          # ~120 rows/suite
    python datasets/fetch_datasets.py --suite gpqa --n 50

Suites that are gated or need their official scorer are stubbed with clear notes
(IFEval, GAIA, SWE-bench Verified) — see NOTES at the bottom.
"""
import argparse
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUBRICS = ROOT.parent / "judge" / "rubrics"

# Verify these HF ids against the current Hub before a real run; some (GPQA) are
# gated and require accepting terms / `huggingface-cli login`.
SUITES = {
    "simpleqa": dict(track="qa", hf="basicv8vc/SimpleQA", split="test"),
    "gpqa": dict(track="reasoning", hf="Idavidrein/gpqa", config="gpqa_diamond", split="train"),
    "mmlu_pro": dict(track="reasoning", hf="TIGER-Lab/MMLU-Pro", split="test"),
    "hotpotqa": dict(track="rag", hf="hotpot_qa", config="distractor", split="validation"),
}

MC_LETTERS = "ABCDEFGHIJ"


def load_rubric(name: str) -> str:
    p = RUBRICS / f"{name}.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def mc_assert(correct_letter: str):
    # Objective, judge-free: the LAST standalone A–J letter in the output must match.
    js = (
        "(() => { const m=(output||'').toUpperCase().match(/\\b([A-J])\\b/g);"
        f"return m && m[m.length-1] === {json.dumps(correct_letter)}; }})()"
    )
    return [{"type": "javascript", "value": js}]


def rubric_assert(rubric_name: str, reference: str):
    body = load_rubric(rubric_name)
    value = f"{body}\n\n## Reference answer\n{reference}\n"
    return [{"type": "llm-rubric", "value": value}]


def row(track, prompt, asserts, desc, **extra):
    vars = {"prompt": prompt, "track": track, "data_class": "public", **extra}
    return {"description": desc[:120], "vars": vars, "assert": asserts}


def build_simpleqa(ds, n):
    out = []
    for r in ds.select(range(min(n, len(ds)))):
        q = r.get("problem") or r.get("question") or ""
        a = r.get("answer") or r.get("target") or ""
        prompt = f"Answer concisely and factually.\n\nQuestion: {q}"
        out.append(row("qa", prompt, rubric_assert("qa", a), q))
    return out


def build_gpqa(ds, n):
    out = []
    for r in ds.select(range(min(n, len(ds)))):
        q = r["Question"]
        # GPQA stores correct + 3 incorrect; present shuffled-but-deterministic.
        choices = [r["Correct Answer"], r["Incorrect Answer 1"],
                   r["Incorrect Answer 2"], r["Incorrect Answer 3"]]
        order = sorted(range(4), key=lambda i: hash((q, i)))
        labeled = {MC_LETTERS[k]: choices[order[k]] for k in range(4)}
        correct = next(L for L, t in labeled.items() if t == r["Correct Answer"])
        block = "\n".join(f"{L}. {t}" for L, t in labeled.items())
        prompt = (
            "Answer this graduate-level question. End your reply with just the letter "
            f"of the correct choice.\n\n{q}\n\n{block}"
        )
        out.append(row("reasoning", prompt, mc_assert(correct), q, answer=correct))
    return out


def build_mmlu_pro(ds, n):
    out = []
    for r in ds.select(range(min(n, len(ds)))):
        opts = r["options"]
        labeled = {MC_LETTERS[i]: t for i, t in enumerate(opts)}
        correct = MC_LETTERS[r["answer_index"]]
        block = "\n".join(f"{L}. {t}" for L, t in labeled.items())
        prompt = (
            "Answer the question. End your reply with just the letter of the correct "
            f"choice.\n\n{r['question']}\n\n{block}"
        )
        out.append(row("reasoning", prompt, mc_assert(correct), r["question"], answer=correct))
    return out


def build_hotpotqa(ds, n):
    out = []
    for r in ds.select(range(min(n, len(ds)))):
        # Distractor config ships the supporting + distractor paragraphs: paste them
        # in-prompt so all three tools read the SAME context (fair, data-safe).
        titles = r["context"]["title"]
        sents = r["context"]["sentences"]
        ctx = "\n\n".join(f"[{t}] {' '.join(s)}" for t, s in zip(titles, sents))
        prompt = (
            "Using ONLY the sources below, answer the question. If the sources do not "
            f"contain the answer, say so.\n\n### Sources\n{ctx}\n\n### Question\n{r['question']}"
        )
        out.append(row("rag", prompt, rubric_assert("rag", r["answer"]), r["question"]))
    return out


BUILDERS = {
    "simpleqa": build_simpleqa,
    "gpqa": build_gpqa,
    "mmlu_pro": build_mmlu_pro,
    "hotpotqa": build_hotpotqa,
}


def write_rows(track, suite, rows):
    d = ROOT / track
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{suite}.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
    )
    # Append into the combined per-track file too.
    combined = d / f"{track}.jsonl"
    with combined.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"  wrote {len(rows):>4} rows → {d.name}/{suite}.jsonl (+ {track}.jsonl)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=120, help="rows per suite")
    ap.add_argument("--suite", choices=list(SUITES), help="only this suite")
    args = ap.parse_args()

    from datasets import load_dataset  # lazy import for a clean --help

    # Clear combined files so reruns don't duplicate.
    for s in SUITES.values():
        c = ROOT / s["track"] / f"{s['track']}.jsonl"
        if c.exists():
            c.unlink()

    targets = [args.suite] if args.suite else list(SUITES)
    for name in targets:
        spec = SUITES[name]
        print(f"{name} ({spec['track']}) ← {spec['hf']}")
        kw = {"split": spec["split"]}
        if spec.get("config"):
            kw["name"] = spec["config"]
        ds = load_dataset(spec["hf"], **kw)
        write_rows(spec["track"], name, BUILDERS[name](ds, args.n))

    print("\nDone. Override per-track at run time, e.g.:")
    print("  npm run eval -- --tests datasets/reasoning/reasoning.jsonl --repeat 5")


if __name__ == "__main__":
    main()

# NOTES — suites that need extra handling (intentionally not auto-generated):
#   IFEval (google/IFEval): grading requires the official instruction_following_eval
#     verifier, not promptfoo asserts. Run targets over its prompts, then score with
#     the upstream checker. Track: qa.
#   GAIA (gaia-benchmark/GAIA): gated on HF; Level-1 only for the agentic track.
#     Caros runs natively; web tools attempt within their limits (differentiation).
#   SWE-bench Verified (princeton-nlp/SWE-bench_Verified): needs container execution.
#     Caros via ../harbor / ../open-model-gym; web tools get a judged code-suggestion
#     variant (no execution). Track: coding.
