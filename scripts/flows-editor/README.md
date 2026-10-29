# Flows editor bridge

The Pipecat flows editor is a browser editor that opens and saves Pipecat
FlowConfig YAML. `flow_bridge.py` moves flow files between the editor and the
harness and refuses files that would break the runtime.

Run it with the Pipecat interpreter, from the repository root (never from inside
the pipecat/flows directory, whose `types.py` shadows the standard library):

    /tmp/voice-harness-pipecat-venv/bin/python -I scripts/flows-editor/flow_bridge.py <command> ...

## Commands

- `export <source-flow> [destination]`: validates a compiled flow (YAML or JSON)
  and writes it as YAML the editor opens as is. YAML text is copied unchanged so
  comments survive; JSON is converted. When the destination is a directory, or is
  omitted, the file goes to `artifacts/flows-editor/` (created if missing).
- `import <editor-file> --to <runtime-path>`: validates the editor-saved file and
  writes it to the runtime path atomically (temporary file in the same directory,
  then replace). On any refusal it exits nonzero, prints every problem on standard
  error one per line, and leaves an existing runtime file untouched. The runtime
  path is required; there is no default.
- `check <file>`: validates only. Exit 0 when valid, 1 when refused.

Validation loads the text through `FlowConfig.from_yaml` with no base directory
(so `!include` is rejected), then lists every cross-reference problem: missing
initial node, missing transition targets (plain, branch case, branch default,
global function), duplicate function names in a node, and a node function that
clashes with a global function. The old editor JSON format (top-level nodes as a
list) is refused. Warnings (lines starting `warning:`) do not fail the command:
function names with characters outside `[A-Za-z0-9_-]` (the model provider
rejects dots in tool names) and single-brace placeholders such as `{firstName}`
that the flow manager does not fill (use double braces).

## Editing in the browser

1. Export: `... flow_bridge.py export <compiled-flow> artifacts/flows-editor/`
2. Open http://127.0.0.1:4335/editor, choose Open, pick the exported file.
3. Edit and save the file from the editor.
4. Import: `... flow_bridge.py import <saved-file> --to <runtime-path>`

## What is edited visually

CRM speaks its own live words, produced by the chosen dialogue model and prompt
setup. It never reads the decision tree's lines out verbatim. The tree's lines are
guidance to the dialogue model and travel in task messages, so the editor does not
offer scripted lines (`tts_say`) and nothing here describes them as how CRM
speaks.

- Node wording, as task messages (guidance the dialogue model puts in its own words).
- Graph edges.
- Branch tables (field, cases, default).
- Transition-only functions.
- End nodes (`end_conversation` actions).
- Catalog tools, as direct functions. The function name comes from the catalog; its
  description and parameters are shown read-only from the catalog and cannot be
  changed in the editor.

## What stays in code (the editor cannot express it)

- Judge gates: code rules, the yes/no question, and the minimum confidence. For a
  catalog tool, judge gating and the credential it needs stay in code and in the
  dispatcher, not in the flow file.
- The never-say lists.
- Dispositions and durable endings.
- Answer actions such as transfer, save details, book, and send text message.
- Extract variables.
- Per-answer minimum confidence and meaning criteria.
- Clarification limits, escalation, the repeat rule, and interrupt ordering.
- The decision module question itself.
- Compliance gates, which always run first.

## Catalog tool statuses

Each catalog tool has a status that says how far it can run today:

- `runs_in_harness_memory`: runs against the harness's own memory. No warning.
- `queued_after_call`: the work is queued and done after the call. No warning.
- `reads_development_project`: reads the development project. No warning.
- `needs_seat_session`: needs a signed-in seat session. Warns.
- `needs_admin_machine_credential`: needs an administrator machine credential. Warns.
- `blocked_on_dana`: older name that counts the same as `needs_seat_session`. Warns.
- `not_yet_built`: has no handler yet. Refused on import.

Every status except `not_yet_built` has a handler. The handlers for the warning
statuses refuse when called, so the agent tells the caller that a producer will follow
up.

Importing rule: when the bridge is given a handlers file, its handler check refuses a
flow that uses a `not_yet_built` tool, because no handler of that name exists. The
import route passes that file only when `src/orchestration-modules/pipecat/flow_handlers.py`
exists; in a tree without it the route does not check handlers and answers with
`handlersChecked: false`, so a `not_yet_built` tool is not refused there. A flow that uses a tool with a
warning status is allowed, and the console page shows a warning for it.

## Runtime path and handlers

`import` writes to `--to`, else the environment variable `VOICE_HARNESS_FLOW_FILE`, else
`src/decision-tree/full-tree.flow.yaml` (the file the flow runtime reads).

Pass `--handlers <file.py or dotted.module>` to `import` or `check` to refuse a flow with a
direct (not transition-only) function that has no handler of the same name. A decision
function added in the editor needs a matching handler in Python, because its description
comes from the handler's docstring and the file cannot carry it.

## Console routes and the catalog copy

The development server (`src/server/flow-editor-routes.ts`) serves three routes for the console page
that frames the editor:

- `GET /api/flow-tools/catalog`: the tool catalog from `src/flow-tools/catalog.json`, or 404
  `catalog_not_found`.
- `GET /api/flows/current`: the runtime flow file (`VOICE_HARNESS_FLOW_FILE`, else
  `src/decision-tree/full-tree.flow.yaml`) as `{path, flowName, yaml, modifiedAt}`, or 404
  `runtime_flow_not_found`.
- `POST /api/flows/import` with `{flowName?, yaml}`: writes the text to a temporary directory under
  `artifacts/flows-editor/`, runs `import` with the pinned Pipecat interpreter (503
  `pipecat_python_not_configured` when `VOICE_HARNESS_PIPECAT_PYTHON` is not usable), passes `--handlers
  src/orchestration-modules/pipecat/flow_handlers.py` only when that file exists, and removes the
  temporary directory. Success is 200 `{ok, path, warnings, handlersChecked}`; a bridge refusal is 422
  `{ok: false, problems}` and the runtime file is untouched. Refusals before the bridge: 415 (content
  type is not application/json), 403 (Origin missing, or not this server's own loopback origin), 413
  (body over 2 megabytes), 400 (not JSON, or `yaml` empty).

To copy the catalog into the editor clone for stand-alone use:

    pnpm exec tsx scripts/flows-editor/sync-catalog.ts [editor-directory]

The directory is the first argument, else `VOICE_HARNESS_FLOWS_EDITOR_DIR`, else
`/Users/patluisexample/Projects/pipecat-flows-editor`. The file lands at
`public/crm/tool-catalog.json`. When the catalog parses, the script prints the destination and
one line with the tool count and the version. It exits 1 with one line when the catalog is missing,
is not valid JSON, or has no tools array.
