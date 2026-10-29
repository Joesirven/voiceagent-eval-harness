/** Synthetic text smoke only: not a model conversation, speech transport, or simulator. */
import assert from "node:assert/strict";
import { buildAgentSystemInstruction } from "../src/modules/agent-instructions.js";
import { OrchestrationRegistry, OwnInfrastructureModule, PipecatModule } from "../src/orchestration-modules/index.js";
const pythonPath = process.env.VOICE_HARNESS_PIPECAT_PYTHON;
assert(pythonPath, "Set VOICE_HARNESS_PIPECAT_PYTHON to the pinned environment interpreter");
const registry = new OrchestrationRegistry([new OwnInfrastructureModule(), new PipecatModule({ pythonPath })], "pipecat");
const smokeInstruction = buildAgentSystemInstruction("synthetic-fixture", {
  leadFirstName: "Smoke", direction: "outbound", disclosure: "Synthetic disclosure.",
}, { leadId: "smoke", name: "Smoke Lead", agencyId: "smoke", phone: "555", priorCallSummaries: [], quoteFields: {}, consentSnapshot: {} });
const session = registry.createSession({ mode: "simulator", input: "text", voiceProviderId: "none-text-only",
  decisionModelId: "synthetic-fixture", decisionRoute: "deterministic", promptSetupId: "synthetic-fixture", configurationRevision: "smoke-1" },
{ route: "deterministic", reply: async (text) => `synthetic reply:${text}` }, { systemInstruction: smokeInstruction });
try {
  await session.start();
  assert.equal(await session.say("synthetic caller frame"), "synthetic reply:synthetic caller frame");
  registry.select("own-infrastructure");
  assert.equal(session.snapshot.orchestrationId, "pipecat");
  await session.end();
  assert.equal(session.state, "ended");
  console.log(JSON.stringify({ runtime: "pipecat-ai==1.13.0", verification: "real PipelineWorker, synthetic decision callback",
    events: session.events().map((event) => event.type), snapshotId: session.snapshot.snapshotId }));
} finally { await session.cancel(); }
