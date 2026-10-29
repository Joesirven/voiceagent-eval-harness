# The decision tree as a Pipecat Flows flow

`src/decision-tree/flow-compiler.ts` compiles the decision tree
(`src/decision-tree/full-tree.json`) into one Pipecat Flows `FlowConfig` in
YAML, `src/decision-tree/full-tree.flow.yaml`, so the tree can drive the
cascaded Deepgram voice path through Pipecat Flows and the operator can open it in the
Pipecat Flows visual editor. Regenerate it with `pnpm tree:flow`; a test fails
when the committed file differs from a fresh compile.
`src/orchestration-modules/pipecat/tree_flow.py` joins it to handlers built
from the same tree: `load_flow(yaml_text, tree_json)` returns a Pipecat `Flow`.

## Why declarative YAML plus generated handlers

The schema (`flow_config.schema.json` in pipecat-ai 1.13.0) forbids extra keys
on nodes, functions, branches and messages, and forbids a description on any
function that runs code. A decision must run code (a later step asks the
harness judge before a gated answer), so each decision is a direct function
whose name is in the YAML and whose description and answer list live in a
Python handler generated from the tree. The compiler exports the same handler
definitions, and a test checks that the Python side builds identical ones.
Pipecat 1.13.0 does not turn a `Literal` annotation into an enum, so
`load_flow` sets each decision's `answer` parameter to a string enum after
building the flow. It refuses, before Pipecat sees it, any flow with a missing
node target or a decision function with no handler.

## Live words always

the operator's decision (2026-10-20): in every call and simulation the agent speaks
its own live words from the chosen dialogue model and prompt setup, never the
tree's template lines as written. So the flow has no `tts_say` action. Every
tree line (a node's agent line, an answer's say line, a refusal line from
`onBlocked.say`, an ending's line, the escalation and repeat rule lines) goes
into the task message of the node it is said on, as guidance phrased like the
decision model path in `sidecar_deepgram.py` (`run_turn`):
`Say this in your own natural words, keeping its meaning: "<line>"`. The same
line also rides as data in `voice_agent_node.guidance` (with its source, and
`direction` for the outbound start) or `voice_agent_disposition.guidance`.
Every node has `respond_immediately: true`, so the language model speaks on
entering the node, except the outbound start (see "The opening disclosure").

## The mapping

- **Nodes.** Each tree node is a flow node keyed by its tree id. Its task
  message holds the situation, the goal, the guidance line (when the node has
  one) or an instruction to open the step briefly in its own words, the
  question, the clarifying line (to say in its own words after `unclear`) and
  the never-say list. Both start nodes carry a role message: the inbound start
  `open.greeting` is `initial_node`, and the outbound start `entry.outbound` is
  recorded in a header comment, in the compile report and in
  `voice_agent_node.start`.
- **Decisions.** One direct function per decision, named `decide_<id>` with
  every character that is not a letter or digit turned into an underscore. It
  branches on the result field `answer`, one case per answer. `unclear` has no
  case, so the flow stays on the node.
- **Follow-up nodes.** The `_more2`, `_more3` and `_more4` nodes fold into their
  root: their answers join the root's decision and the `other` links go.
  Compilation fails on a colliding answer name, or when a follow-up is entered
  any other way.
- **Placeholders** stay single-brace (`{firstName}`, `{slotWords}`) in the
  guidance: Pipecat's own `{{ key }}` filling raises on a missing key, so the
  runtime fills them.
- **Answers with a line and a next node** enter a copy of the target,
  `<target>.via.<answer>`, whose guidance line is the answer's line. A copy
  differs from its base only in that guidance line (and in the copy marks in
  `voice_agent_node`).
- **Judge-gated answers** get an extra case, `<answer>__blocked`, entering
  a copy of `onBlocked.next` (or of the source node), `<base>.blocked.<answer>`,
  whose guidance line is `onBlocked.say`. This matches the tree engine, which
  says only the refusal line. Mapping the blocked case back to the source node
  would bring back that node's own line instead. For now the handler returns
  the answer unchanged.
- **Endings.** One node per distinct line and disposition pair
  (`end.<disposition>`, then `end.<disposition>.2` and so on). Its task message
  opens with the instruction to call no function (not even `interrupt`, which
  Pipecat still offers there), then tells the language model to close the call
  in its own words, keeping the meaning of the ending's line. A `voice_agent_disposition`
  pre action carries the disposition and the line; `end_conversation` is the
  one post action. The escalation and repeat rule endings are emitted too, so
  the runtime has a node to enter.
- **Interrupts** are the one global function, `interrupt`. `none`, `unclear`
  and answers with `"resume": true` have no case. Every interrupt target
  offers `interrupt` too, so each target's task message (and its copies') says
  not to call `interrupt` with the answer that leads to that step.
- **Resume answers** (say the line, then ask the current node's question
  again) stay on the current node: the generated `interrupt` handler returns
  the answer, its `say` line and an instruction to say it in its own natural
  words, keeping its meaning, then ask the step's question again in its own
  words, keeping the meaning of the base tree node's own agent line, or its
  clarifying line, as the tree engine does. At a start node the instruction
  also quotes the disclosure the harness has already said (from
  `voice_agent_tree.disclosure`) and says to leave out every sentence that says
  the agent is an artificial intelligence assistant or that the call is recorded, since the line
  asked again can itself carry disclosure sentences. The line also rides in
  `voice_agent_tree.interrupts`. That result is a tool result, which Pipecat
  does not render, so the runtime must fill single-brace placeholders such as
  `{firstName}` there too.

## The opening disclosure

The harness speaks the compliance disclosure itself, word for word, before
the tree starts: the Deepgram sidecar queues it as line 0 and Node's
`disclosure_check` verifies the spoken words (`src/server/voice/deepgram-voice-session.ts`).
It is a legal disclosure, not a tree template line, so it is not spoken by
the flow. The tree's start nodes still ask for it: `open.greeting` has the goal
"Say both required disclosures word for word", a line with two disclosure
sentences in it, and the never-say item "Anything before the two disclosure
sentences"; the outbound line opens with "This call is recorded". So both
start nodes (and any copy of them) carry, in their task message:

- the exact words the harness has just said, quoted. They come from
  `src/compliance/disclosures.ts` (`inboundOpeningScript`, and
  `outboundDisclosure`, which the engine's `open` uses too), and ride as data
  in `voice_agent_tree.disclosure` (`inbound`, `outbound`);
- that each part of the step about the disclosure is already done, named one
  by one: the goal's part about saying the disclosures, the disclosure
  sentences in any line, and any never-say item about what comes before the
  disclosure sentences (everything the model says now comes after them);
- a rule that does not depend on wording: leave out every sentence that says
  the agent is an artificial intelligence assistant or that the call is recorded, however it is
  worded. The quote alone is not enough, since the tree's lines word the
  disclosure differently ("may be recorded for quality and training" against
  the harness's "recorded and may be reviewed to improve service");
- right after the guidance line, the same rule again for that line, then to
  say the rest.

`voice_agent_node.disclosureSaidByHarness: true` marks those nodes.

What the harness says first differs by direction (`open` in
`src/decision/engine.ts`, whose first line the voice paths speak as line 0),
and so does whether the start node responds at once:

- **Inbound.** The harness says the inbound disclosure only
  (`inboundOpeningScript` in `src/compliance/disclosures.ts`), which states
  facts and asks nothing. `open.greeting` responds at once
  (`respond_immediately: true`): its goal (name the agency, ask one open
  question) is still to do, and waiting would leave the line silent. The
  harness's own prompt setup opens an inbound call in the same two turns
  (`disclosureRows` in `src/behaviour/prompt/sections.ts`). The tree engine
  waits for the caller here, so this is recorded as a departure in the
  compile report.
- **Outbound.** The harness says the outbound disclosure followed by the
  outbound start's own outbound line ("This call is recorded. Is this
  {firstName}?"), so the start's question has already been asked.
  `entry.outbound` waits for the caller (`respond_immediately: false`), as the
  tree engine does; its task message quotes that line, says not to repeat it
  and to decide on the caller's reply, and `voice_agent_node.guidance` marks the
  line `saidByHarness`. Nothing else in the tree enters `entry.outbound`, so it
  is never entered mid-call in silence. When the outbound start has no
  outbound line, the outbound opening is the disclosure alone and the node
  responds at once like the inbound start.

Tests check both directions, and the case with no outbound line. That the
harness speaks the outbound start's line as written is the harness's
behaviour, outside this flow.

## Endings: what Pipecat does with the post action

Checked in the pinned pipecat-ai (`/tmp/voice-agent-pipecat-venv`, Pipecat
Flows inside it):

- `pipecat/flows/manager.py`, `_set_node`, lines 778 to 788: on a
  `respond_immediately` node the manager first queues an `LLMRunFrame`, then
  runs the post actions at once (only a node that does not respond
  immediately defers them to the next bot-stopped-speaking frame).
- `pipecat/flows/actions.py`, `_handle_end_action`, line 358:
  `end_conversation` queues an `EndFrame`, so it lands in the pipeline behind
  the run frame. `EndFrame` is a control frame, processed in order.
- `pipecat/services/openai/base_llm.py`, lines 695 to 698: the language model
  service awaits the whole completion for a context frame before it takes the
  next frame, so the reply's text frames go downstream before the `EndFrame`.
- `pipecat/services/tts_service.py`, lines 1084 and 1180 to 1215: on the
  `EndFrame` the text to speech service flushes the remaining text and holds
  the frame until open audio contexts finish.
- `pipecat/transports/base_output.py`, lines 372 and 561 to 568: the output
  transport puts the `EndFrame` at the end of its audio queue, so queued audio
  plays before it stops.

So the closing words are spoken, then the call ends. The earlier workaround
(`end_conversation` as the last pre action after a `tts_say` line) is gone:
there is no fixed line left to race. Two limits:

- `EndFrame` is not interruptible (`pipecat/frames/frames.py`, line 2328), so
  a caller who talks over the closing words can cut them short while the call
  still ends.
- Pipecat adds the global functions to every node (`manager.py`, `_set_node`:
  the global functions come first in the node's function list), so an ending
  still offers `interrupt`. A function call at an ending loses the closing
  words: the model's turn is the call, not speech, and the follow-up model run
  that a function result triggers comes after the `EndFrame`, which stops the
  language model service (`pipecat/services/llm_service.py`, `stop`, line 735;
  when function calls do not run in parallel it also cancels the sequential
  function call runner). The caller's last line
  before an ending is often the very thing that led there (a stop request,
  say), which fits an interrupt answer. The prompt is the fix: the role
  message makes endings the one exception to "one function per caller line"
  (call no function, not even `interrupt`, only speak the closing words), and
  each ending's task message opens with the same instruction. As a backstop,
  the generated `interrupt` handler ignores every interrupt at an ending (a
  flow node with a `voice_agent_disposition` pre action): no transition, and no
  second disposition from another ending. It cannot bring the closing words
  back.

## Carried as data

Custom actions are the only entries that allow extra keys, so tree data rides
in them. A runtime must register a handler (a no-op is enough) for each type
before it enters a node, or Pipecat raises:

| Action | Where | What |
| --- | --- | --- |
| `voice_agent_tree` | both start nodes | id, version, starts, the disclosure words the harness speaks per direction, maxClarifications, escalation and repeat rule (with their ending nodes), interrupt minimum confidences, clarifying line, and each interrupt answer's say line and resume flag |
| `voice_agent_node` | every non-ending node | tree id, label, area, flowStep, guidance line (text, source, direction, saidByHarness), start direction, disclosureSaidByHarness, clarifying line, repeatKey, node escalation, promise, folded follow-ups, and which edge entered a copy |
| `voice_agent_answers` | every non-ending node | per answer: minConfidence, carry, extract, say, and the follow-up it came from |
| `voice_agent_gates` | nodes with gated answers | per gated answer: judge (codeRules, question, minConfidence), action, disposition, onBlocked, blocked case name |
| `voice_agent_disposition` | endings | disposition, whether it is durable, and the ending's guidance line |

The runtime must enforce: minimum confidences, the judge, clarification
counting and escalation, the repeat rule, extract and carry, and the outbound
start (`voice_agent_node.guidance.direction` is `outbound` on `entry.outbound`,
and `voice_agent_node.start` names the direction).
Copies carry their base's repeat key and escalation, so the runtime counts
clarifications and repeat keys by `voice_agent_node.treeNode`, never by flow node
key, and does not count entering a blocked copy as the objection coming up
again.
The generated `interrupt` handler ignores an interrupt whose target is the
tree node the call is on, as the tree engine does (`checkInterrupt` in
`src/decision/engine.ts`). It reads `flow_manager.current_node`, the flow node
key, and maps it to that node's `voice_agent_node.treeNode` (`load_flow` builds
the map from the YAML), so via and blocked copies count as their base node.
Its result's answer is then `none`, which has no case, so the flow stays, and
the result tells the language model it is already at that step and must call
the step's own decision function. Without this, a caller at
`compliance.stop_clarify` saying "yes, stop calling me" fits the interrupt
`asks_to_stop`, and the flow would re-enter the node and repeat its opening
instead of reaching `compliance.stop_apply`.
Comments show each node's label and area, and each case's minimum confidence.

## Output contract

For any consumer of the compiled file, such as a customer relationship management system adapter that loads it
through `VOICE_HARNESS_FLOW_FILE`:

- **File.** `src/decision-tree/full-tree.flow.yaml`, generated by
  `pnpm tree:flow` from `src/decision-tree/full-tree.json`; never edited by
  hand. One Pipecat Flows `FlowConfig` that `FlowConfig.from_yaml` loads.
  The flows editor bridge (`scripts/flows-editor/flow_bridge.py import`)
  writes an editor-saved flow to `VOICE_HARNESS_FLOW_FILE`, by default this same
  path, so a port may be loading an editor-saved flow rather than a fresh
  compile; a test fails when the committed file differs from a fresh compile.
- **Top-level keys.** Exactly `initial_node`, `global_functions` and `nodes`.
  `initial_node` is the inbound start (`open.greeting`); an outbound call must
  enter `entry.outbound` itself (`voice_agent_node.start` says which is which).
  Each node has one `developer` task message, `functions` (none on endings),
  `pre_actions`, `post_actions` (endings only: `end_conversation`) and
  `respond_immediately`, which is `true` everywhere except the outbound start
  when the harness's outbound opening already asked its question; only the
  two start nodes have a `role_message`.
- **Node keys.** A tree node keeps its tree id. Copies are
  `<target>.via.<answer>` (entered after an answer's say line) and
  `<base>.blocked.<answer>` (entered when the judge refuses a gated answer).
  Endings are `end.<disposition>`, then `end.<disposition>.2` and so on.
- **Function names.** `decide_` plus the tree id with every character that is
  not a letter or digit turned into an underscore (`open.greeting` becomes
  `decide_open_greeting`), always matching `^[a-zA-Z0-9_-]{1,64}$`. The one
  global function is `interrupt`. Every function branches on the result field
  `answer`; the case names are the tree's answer names, plus
  `<answer>__blocked` for a gated answer, which is never offered to the
  language model.
- **Handlers.** The YAML names the functions but cannot run them: a port must
  supply a handler for every function name. `load_flow(yaml_text, tree_json)`
  in `src/orchestration-modules/pipecat/tree_flow.py` builds them from the
  same tree, with the answer enum, the current-node guard, the ending guard
  and resume handling; it reads the node map, the ending nodes and the
  disclosure words from the flow file itself.
- **Custom actions.** A port registers all five types (`voice_agent_tree`,
  `voice_agent_node`, `voice_agent_answers`, `voice_agent_gates`,
  `voice_agent_disposition`) before entering a node, or Pipecat raises. Judge
  gates are in `voice_agent_gates`, dispositions in `voice_agent_disposition`,
  answer data (minimum confidences, carry, extract, say lines) in
  `voice_agent_answers`, the tree-wide rules in `voice_agent_tree`, and each
  node's guidance line in `voice_agent_node.guidance` (endings:
  `voice_agent_disposition.guidance`). The same guidance is already in the
  task message, so a port that only runs the flow needs no handler logic for
  it.
- **No spoken text.** There is no `tts_say` action; every tree line is
  guidance for the language model to say in its own words. Placeholders such
  as `{firstName}` are single-brace and the port fills them, in task messages
  and in the `interrupt` handler's results.
- **Self-contained.** No includes, no anchors, aliases or tags, and no
  repository-relative paths; the file loads with no base directory.
- **The disclosure** is not spoken by the flow. A port must speak the
  compliance disclosure itself, word for word, before it enters the start
  node. The flow assumes these exact words: they are quoted in the start
  nodes' task messages and carried in `voice_agent_tree.disclosure` (`inbound`,
  `outbound`). A port that speaks other words must change
  `src/compliance/disclosures.ts` and recompile, or the quote is false. The
  start nodes (marked `voice_agent_node.disclosureSaidByHarness`) tell the
  language model it has been said, which parts of the step it satisfies, and
  to leave out any sentence about being an artificial intelligence assistant or the call being
  recorded. The port need not add the disclosure to the language model
  context itself. On an outbound call
  the port must also say the outbound start's outbound line right after the
  disclosure, as the harness does, since `entry.outbound` then waits for the
  caller.

## The flow runtime protocol

`src/orchestration-modules/pipecat/flows_runtime.py` (`FlowsRuntime`) runs the
flow in a Pipecat pipeline. Node keeps the tree state, the records and the
judge; the runtime reports to Node as JSON lines and asks Node for judge
verdicts and tool results, each with a timeout. Node's side for one call is
`src/server/voice/flow-runtime-bridge.ts`. Neither is wired into the Deepgram
session yet.

- `FlowsRuntime(flow_yaml, tree_json, emit, request=None, catalog=None)`;
  `attach(worker, llm, context_aggregator, transport=None)` builds the
  `FlowManager` and registers the five custom actions; `start(direction)`
  enters `open.greeting` inbound or `entry.outbound` outbound;
  `caller_turn(text)` and `agent_turn(text)` are called by the sidecar on
  every finished line, before the flow sees a caller line;
  `handle_message(line)` takes Node's replies.
- `load_flow(yaml, tree, gate=None, catalog=None, request=None)`: with the
  parsed `src/flow-tools/catalog.json` it adds one handler per catalog tool
  whose status is not `not_yet_built` (`flow_tools.py`, joined in
  `flow_handlers.py`), accepts those names in `flow_problems`, and sets each
  tool schema's description, properties and required from the catalog.

Runtime to Node:

| Message | When | Node does |
| --- | --- | --- |
| `{"type":"node_enter","node","treeNode","label","flowStep"?}` | a node is entered (`voice_agent_node`) | trace `node_enter` `{nodeId: treeNode, label}` as the engine's `enter()`; `dispatcher.setNode` |
| `{"type":"decision","node","treeNode","function","answer","router":"pipecat_flows"}` | the model calls a decision function, before its handler runs | trace `decision` `{nodeId, answer, module and router "pipecat_flows", routed "proceed"}`; `interrupt` is recorded at node `interrupts`, as the engine does |
| `{"type":"judge_request","requestId","function","answer","node","treeNode","judge","action","disposition"}` | before a judge-gated answer | runs `guardedAction` for the action, then for `end_with_disposition` with that action counted as done (as the engine does), verdict only (nothing runs), and replies `{allow, reason}` |
| `{"type":"judge_verdict","function","answer","node","treeNode","allowed","timedOut","latencyMs","reason"?}` | after every judge request | counts the allowed actions as done only when `allowed` is true (an allow that came after the timeout was not taken); the verdict itself was traced by `guardedAction`, and a timeout adds a `judge_error` trace with code `judge_timed_out` |
| `{"type":"tool_call","requestId","name","arguments"}` | a catalog tool is called | `dispatcher.dispatch`, and replies with its result `{ok, speakable, refused?, endCall?}` |
| `{"type":"caller_turn","text"}` | every finished caller line | `dispatcher.hearCaller`: a stop phrase calls `onStop`, which ends the call |
| `{"type":"agent_turn","text"}` | every finished agent line, the disclosure first | `dispatcher.sayAgent`, so the judge sees the transcript |
| `{"type":"disposition","node","disposition","durable","guidance"}` | an ending is entered (`voice_agent_disposition`) | trace `disposition` |

Node to runtime: `{"type":"flow_reply","requestId","result"}`. Request ids are
`flow-<n>` in the field `requestId`, never `id`, so they cannot be mistaken
for the Deepgram sidecar's own lines. Timeouts: 2 seconds for the judge (no
reply refuses, and the flow takes the blocked case), 8 seconds for a tool (no
reply returns `{ok: false, refused: {code: "no_reply"}}`). A late reply is
ignored. Every catalog tool returns `(result, TRANSITION_IN_YAML)`, so the
flow file decides whether the call moves on; a tool with no `transition_to`
stays on the node and the model speaks the result. Tools that need a seat
session or the admin machine credential have handlers too: the dispatcher
refuses them and its result says a licensed producer will follow up.

Not done yet: the hook in `sidecar_deepgram.py` and the wiring in the voice
manager; the gated `book` and `save_quote_field` actions take their values
from the call's variables (`from`), which Node does not have in flow mode, so
the code rules refuse them; no confidence is reported with a decision.

## What is lost

- The `other` links and their `carry`: there is no second question any more.
- The follow-up nodes' own lines and clarifying lines as guidance (kept as
  data only, in `voice_agent_node.folded`).
- `cues` (keyword mock decision modules only), and the documentation fields
  `handoffTriggers`, `sources`, `closesGaps` and `crmEquivalent`.

`pnpm tree:flow --report` prints the full report as JSON.

## Tests

`tests/decision-tree/flow-compiler.test.ts` derives every expected count from
the loaded tree, so the tree can change without editing the tests; only
structural limits are fixed (at most two tools at one node: the node's
decision function and `interrupt`). The same checks also run on a changed
copy of the tree made inside the test (one answer added, resume set on an
interrupt answer, an interrupt target moved); `full-tree.json` is never
edited. `scripts/call_tree_flow_tool.py` calls a loaded flow's tools at given
nodes with a minimal stand-in flow manager (no network), and the tests use it
for the interrupt guard, copies included, for resume answers (both start
nodes and a copy), and for interrupts at every ending.

## Checking it in Pipecat

With `VOICE_HARNESS_PIPECAT_PYTHON` set to the pinned Pipecat Python, the tests
load the flow through `scripts/check_tree_flow.py`. Full validation against
`flow_config.schema.json` needs the `jsonschema` module in that Python; without
it only a key check runs (required and extra keys, no types or enums) and the
test prints a warning. Set `VOICE_HARNESS_REQUIRE_SCHEMA_VALIDATION=1` to make the
missing module a failure.
