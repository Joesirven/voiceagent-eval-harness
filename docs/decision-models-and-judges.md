# Decision models and judges

Decision models choose an answer from a closed set. Judges evaluate a proposed action, one turn, or a complete call. The harness keeps these roles separate from the voice module.

## Decision models

The contract is in `src/decision-models/types.ts`. An adapter returns `{ ok: false, reason }` for failure. It does not throw. Each live adapter has a deterministic mock that needs no network credential.

The model receives redacted conversation lines, a node identifier, one closed question, and criteria for each answer. Every question includes an `unclear` answer. Confidence means the probability assigned to the selected answer.

Load connector credentials from a file outside the repository. The loader refuses a file with broad permissions. It does not print keys or environment-file content.

## Live action judge

The live judge runs code rules first. A code refusal stops the action without a model call. If code allows the action, one fast decision-model call checks whether the caller supplied the required evidence.

The action is blocked only when the answer is `block` and its confidence meets the configured threshold. Timeouts and adapter failures are recorded in the trace. The configured failure policy decides whether the action proceeds.

## Offline judges

The turn judge compares an agent reply with a reference reply in both presentation orders. It reports better, worse, same, or inconsistent.

The whole-call judge plays a complete synthetic call. It grades required facts, disposition, outcome, safety rules, and unsupported claims.

The analysis tool builds confusion tables and a worksheet for human review. It computes confidence thresholds only from adjudicated results.

## Data rules

- Use synthetic or explicitly supplied evaluation transcripts.
- Redact call text before a model request.
- Keep provider retention settings explicit.
- Do not write credentials, raw keys, or environment-file content to traces.
