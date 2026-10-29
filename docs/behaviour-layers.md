# Behaviour layers

"Training" the voice agent here means enforcing logic, personality, evaluations and
judge layers. Nothing is fine-tuned. This directory-level guide is the contract the
modules under `src/behaviour/` are built against.

## What lives where

| Path | What it is |
|---|---|
| `src/behaviour/data/*.json` | Imported, then hand-corrected, from the reviewed training outputs: `playbook.json`, `enforcement-rules.json`, `grading-rubric.json`. Source of truth now; each item keeps its archive citations. Citations are data only and never go into prompt text. |
| `src/behaviour/types.ts`, `rules.ts`, `switches.ts` | Shared types, the 36 rules and the code that enforces each one, the legal blocks switch. |
| `src/behaviour/guard/` | Checks on agent lines before they are spoken: the speech guard, text message guard, opt-out, objection counter, classifiers, quote field allowlist, handoff validation, redaction, opening disclosure, legal-layer checks. |
| `src/behaviour/audit/` | The transcript audit (the same families, run over a finished call) and the interface for the model-graded pass that runs offline. |
| `src/behaviour/prompt/` | The system prompt builder, personality profiles, swappable prompt setups, the style lint. |
| `src/behaviour/grading/` | The rubric loader and the deterministic scorer. Judges load the data; this is not a judge. |
| `tests/behaviour/` | Corpora and tests. |

## Two layers, one switch

* **Behaviour rules never switch off.** No price, no coverage advice, no comparing,
  no eligibility judgement, no binding, no payment, no policy changes, no pressure,
  never hiding that the caller is speaking with an artificial intelligence, no
  invented claims, no sensitive identifiers. Layer "behaviour".
* **Legal blocks** sit behind `getLegalBlocks()` (`"enforced"` default, or
  `"suspended"` for the local testing harness): the recording notice, the agreed-time
  window, no speech to a voicemail, caller identification, the opt-out footer on texts.
  Layer "legal". Suspended means: no finding is raised, and the prompt omits those
  blocks. Nothing is deleted.
* The switch does not decide who may be dialled. The dial path owns that. Test mode
  must still only reach the operator's own phone, a browser or a simulated line.

## Seams for the rest of the harness (pure functions, no hidden state)

* `guardAgentLine(text, ctx)` returns `{ allowed, spokenText, findings }`. Call it on
  every agent line before it is committed or played. On a block, `spokenText` is the
  producer-only fallback line.
* `auditTranscript(...)` runs the same families, plus sequence checks, over a finished call.
* `buildSystemPrompt(setupId, promptContext, options)` returns the prompt text and
  its section list for the voice provider session.
* `loadRubric()` returns the grading rubric as data; `scoreCall(...)` scores the parts
  that code can decide, as lines shaped `{ criterion, score, note }`, the same shape
  the judges already use.
