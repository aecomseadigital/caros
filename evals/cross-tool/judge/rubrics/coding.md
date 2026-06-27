# Code-suggestion rubric (web tools only — no execution)

Caros is graded on the coding/agentic track by **execution** via `../open-model-gym`
and `../harbor`, not by this rubric. This rubric scores only the non-executing web
tools (Oscar, Copilot), which can return code text but cannot run it.

Bias controls:
- Do **not** reward explanation length; the code's correctness is what matters.
- Mentally trace the code against the task spec (and Reference if provided).

**PASS** only if the proposed code correctly solves the stated task and would
plausibly compile/run. Partially-correct or non-compiling code → FAIL.
