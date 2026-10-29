# Architecture

The harness separates call transport, voice processing, decision logic, data access, and evaluation. This separation lets one test setup change without changing the others.

## Main parts

| Part | Purpose |
| --- | --- |
| Harness server | Starts simulated or live calls, applies safety rules, records traces, and serves the browser application. |
| Voice Agent Console | Selects a fictional lead and setup. It shows the live transcript, decision state, trace, and judge results. |
| Voice modules | Adapt a text simulator, browser audio, or a phone transport to the same call interface. |
| Orchestration modules | Run the conversation directly or through Pipecat. |
| Decision modules | Select decision-tree answers from caller speech. Mock modules keep tests deterministic. |
| Judge modules | Grade turns and complete calls without changing the active call. |
| Lead store | Supplies lead context through the `LeadStore` interface. The default implementation contains only fictional data. |
| Record store | Writes local JSON line records or harness database rows. |

## Call path

1. The caller or simulator supplies audio or text.
2. A voice module produces caller turns.
3. The orchestration module sends each turn to the selected decision and reply path.
4. Safety guards check proposed actions before dispatch.
5. The harness emits trace events and updates the console.
6. The record store saves the transcript, setup snapshot, outcome, and judge results.

## Data boundaries

The repository includes a mock lead store and synthetic fixtures. It does not include a customer relationship management system adapter. Implement `LeadStore` to connect one. Keep credentials and customer data outside the repository.

The browser receives only the data needed for the current view. Server-side adapters own credentials and external writes. Test mode can suspend legal blocks for synthetic calls, but the library default remains `enforced`.

## Generated files

The decision tree compiles to `src/decision-tree/full-tree.flow.yaml` with `pnpm tree:flow`. Do not edit the compiled file by hand.
