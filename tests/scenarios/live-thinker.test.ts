/**
 * The thinker on the direct Azure gpt-live path: the responses delegation in
 * session.start, the thinker's function calls run through the flow tool
 * dispatcher and answered on the socket, the delegation replaced when the step
 * guidance changes, and the environment switch. Fake socket, fake timers, no
 * network and no credential file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { resetHarnessConfig } from "../../src/config.js";
import { FLOW_TOOL_CATALOG } from "../../src/flow-tools/catalog.js";
import type { FlowDispatcher } from "../../src/flow-tools/dispatch.js";
import { AzureLiveSession, THINKER_SETTLE_MS, type LiveSessionOptions, type LiveSocket } from "../../src/modules/azure-live-session.js";
import { DEFAULT_DECISION_CHAT_DEPLOYMENT } from "../../src/server/live-judge-wiring.js";
import {
  createLiveThinker,
  createLiveThinkerForCall,
  LIVE_THINKER_ENV,
  liveThinkerStatus,
  THINKER_SPEAKER_NOTE,
  thinkerInstructions,
  thinkerTools,
  type LiveThinker,
} from "../../src/server/voice/live-thinker.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const GAP_MS = 100;
const CALL = "call_thinker";
const LEAD = "lead-1";

interface FakeSocket {
  socket: LiveSocket;
  sent: Array<Record<string, unknown> & { type?: string }>;
  emit(event: Record<string, unknown>): void;
}

function fakeSocket(): FakeSocket {
  let onMessage: (raw: string) => void = () => undefined;
  const fake: FakeSocket = {
    sent: [],
    emit: (event) => onMessage(JSON.stringify(event)),
    socket: {
      send: (data) => void fake.sent.push(JSON.parse(data)),
      close: () => undefined,
      onMessage: (cb) => void (onMessage = cb),
      onClose: () => undefined,
    },
  };
  return fake;
}

function options(fake: FakeSocket, patch: Partial<LiveSessionOptions> = {}): LiveSessionOptions {
  return {
    socketFactory: async () => fake.socket,
    credentials: () => ({ liveUrl: "wss://example.openai.azure.com/openai/v1/live/sessions", apiKey: "k" }),
    trace: { leadId: LEAD, recordId: CALL, channel: "call", direction: "inbound", callId: CALL },
    model: "gpt-live-1",
    voice: "marin",
    instructions: "You are the agency's assistant. Lead: Pat.",
    disclosure: "Hi, I am an artificial intelligence assistant.",
    maxMs: 60_000,
    turnGapMs: GAP_MS,
    startTimeoutMs: 1_000,
    dialogOwnsTranscript: false,
    onAudio: () => undefined,
    onClearPlayback: () => undefined,
    onEnd: () => undefined,
    ...patch,
  };
}

async function started(patch: Partial<LiveSessionOptions> = {}) {
  const fake = fakeSocket();
  const session = new AzureLiveSession(options(fake, patch));
  const starting = session.start();
  await vi.advanceTimersByTimeAsync(0);
  fake.emit({ type: "session.started" });
  await starting;
  return { session, fake };
}

/** A thinker whose calls are recorded instead of dispatched. */
function fakeThinker(result: { output: string; endCall?: boolean; ok?: boolean; refusedCode?: string } = { output: '{"ok":true}' }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const thinker: LiveThinker & { calls: typeof calls; stopped: number } = {
    calls,
    stopped: 0,
    delegation: (guidance) => ({ type: "responses", responses: { model: "fake-thinker", instructions: `base${guidance ? ` | ${guidance}` : ""}`, tools: [], tool_choice: "auto" } }),
    call: async (name, args) => {
      calls.push({ name, args });
      return { output: result.output, endCall: result.endCall ?? false, ok: result.ok ?? true, refusedCode: result.refusedCode };
    },
    stop: () => void (thinker.stopped += 1),
  };
  return thinker;
}

const functionCall = (call_id: string, name: string, args: unknown) => ({
  type: "response.event",
  event: { type: "response.output_item.done", item: { type: "function_call", call_id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) } },
});

const toolTraces = (tool: string) => traceBus.history().filter((e) => e.type === "tool_call" && e.data.tool === tool);

beforeEach(() => {
  vi.useFakeTimers();
  traceBus.reset();
  resetHarnessConfig();
  resetLeadStore();
  seedLead(baseLead({ id: LEAD }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the delegation in session.start", () => {
  it("names the deployment, tool_choice auto and the dispatched catalog tools only", async () => {
    const thinker = createLiveThinker({ deployment: "gpt-5.6-luna", agentInstructions: "Be brief.", dispatcher: {} as FlowDispatcher });
    const { fake } = await started({ thinker });
    const start = fake.sent.find((m) => m.type === "session.start")!;
    const delegation = (start.session as { delegation: { type: string; responses: Record<string, unknown> } }).delegation;
    expect(delegation.type).toBe("responses");
    expect(delegation.responses.model).toBe("gpt-5.6-luna");
    expect(delegation.responses.tool_choice).toBe("auto");
    expect(delegation.responses.reasoning).toEqual({ effort: "low" });
    expect(delegation.responses.instructions).toContain("Be brief.");
    const names = (delegation.responses.tools as Array<{ type: string; name: string; parameters: unknown }>).map((t) => t.name);
    expect(names).toContain("write_quote_field");
    expect(names).toContain("end_call");
    expect(names).not.toContain("check_carrier_appetite");
    expect(names).not.toContain("start_quote");
    expect(names).not.toContain("take_message");
    for (const t of delegation.responses.tools as Array<{ type: string }>) expect(t.type).toBe("function");
  });

  it("sends no delegation when there is no thinker", async () => {
    const { fake } = await started();
    const start = fake.sent.find((m) => m.type === "session.start")!;
    expect(start.session).not.toHaveProperty("delegation");
  });

  it("thinkerTools carries each catalog tool's own parameters and leaves out console and unbuilt tools", () => {
    const tools = thinkerTools(FLOW_TOOL_CATALOG);
    const expected = FLOW_TOOL_CATALOG.tools.filter((t) => t.status !== "not_yet_built" && t.status !== "runs_in_console");
    expect(tools.map((t) => t.name)).toEqual(expected.map((t) => t.name));
    const write = tools.find((t) => t.name === "write_quote_field")!;
    expect(write.parameters).toBe(FLOW_TOOL_CATALOG.tools.find((t) => t.name === "write_quote_field")!.parameters);
    expect(Object.keys(write.parameters.properties)).not.toContain("lead_id");
  });

  it("traces the delegation Azure opens", async () => {
    const { fake } = await started({ thinker: fakeThinker() });
    fake.emit({ type: "session.delegation.created", delegation: { id: "d1", target: "responses" } });
    expect(toolTraces("delegation_opened")).toHaveLength(1);
    expect(toolTraces("delegation_opened")[0]!.data.inputs).toEqual({ target: "responses" });
  });
});

describe("the thinker's function calls", () => {
  it("answers a function call with its output, then one response.create after the settle", async () => {
    const thinker = fakeThinker({ output: '{"ok":true,"speakable":"Saved."}' });
    const { fake } = await started({ thinker });
    fake.emit(functionCall("call_1", "write_quote_field", { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(thinker.calls).toEqual([{ name: "write_quote_field", args: { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" } }]);
    const outputs = fake.sent.filter((m) => m.type === "response.item.create");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.item).toEqual({ type: "function_call_output", call_id: "call_1", output: '{"ok":true,"speakable":"Saved."}' });
    expect(fake.sent.filter((m) => m.type === "response.create")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS + 5);
    expect(fake.sent.filter((m) => m.type === "response.create")).toHaveLength(1);
    const trace = toolTraces("thinker_tool_call");
    expect(trace).toHaveLength(1);
    expect(trace[0]!.data.inputs).toEqual({ name: "write_quote_field", callId: "call_1" });
    expect(trace[0]!.data.success).toBe(true);
  });

  it("waits for the second call of the same turn before response.create", async () => {
    const thinker = fakeThinker();
    const { fake } = await started({ thinker });
    fake.emit(functionCall("call_1", "write_quote_field", {}));
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS / 2);
    fake.emit(functionCall("call_2", "save_message", {}));
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS / 2 + 5);
    expect(fake.sent.filter((m) => m.type === "response.item.create")).toHaveLength(2);
    expect(fake.sent.filter((m) => m.type === "response.create")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS);
    expect(fake.sent.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("reads bad argument JSON as an empty object and records a refusal with its code", async () => {
    const thinker = fakeThinker({ output: '{"ok":false}', ok: false, refusedCode: "bad_arguments" });
    const { fake } = await started({ thinker });
    fake.emit(functionCall("call_1", "write_quote_field", "{not json"));
    await vi.advanceTimersByTimeAsync(0);
    expect(thinker.calls).toEqual([{ name: "write_quote_field", args: {} }]);
    const trace = toolTraces("thinker_tool_call")[0]!;
    expect(trace.data.success).toBe(false);
    expect(trace.data.reason).toBe("bad_arguments");
  });

  it("ignores the thinker answering with words and malformed events without ending the session", async () => {
    const { session, fake } = await started({ thinker: fakeThinker() });
    fake.emit({ type: "response.event", event: { type: "response.output_item.done", item: { type: "message", content: [] } } });
    fake.emit({ type: "response.event", event: { type: "response.completed", response: { output: [] } } });
    fake.emit({ type: "response.event", event: "garbage" });
    fake.emit({ type: "response.event" });
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS + 5);
    expect(session.isEnded).toBe(false);
    expect(fake.sent.filter((m) => m.type === "response.item.create" || m.type === "response.create")).toHaveLength(0);
  });

  it("runs write_quote_field through a real dispatcher that heard the caller's line first", async () => {
    const thinker = createLiveThinkerForCall({
      callId: CALL,
      leadId: LEAD,
      agencyId: baseLead().agencyId,
      direction: "inbound",
      agentInstructions: "You are the agency's assistant.",
      deployment: "gpt-5.6-luna",
      store: mockLeadStore,
      clock: { now: () => new Date("2026-10-15T14:00:00.000Z") },
    });
    const { fake } = await started({ thinker });
    // The agent's spoken disclosure reaches the dispatcher from the trace bus, as the judge requires it first.
    fake.emit({ type: "session.output_transcript.delta", delta: inboundOpeningScript() });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    fake.emit({ type: "session.input_transcript.delta", delta: "Our renewal is in March 2027." });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    fake.emit(functionCall("call_9", "write_quote_field", { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" }));
    await vi.advanceTimersByTimeAsync(THINKER_SETTLE_MS + 5);
    const output = fake.sent.find((m) => m.type === "response.item.create")!;
    const item = output.item as { call_id: string; output: string };
    expect(item.call_id).toBe("call_9");
    const parsed = JSON.parse(item.output) as { ok: boolean; refused?: { code: string } };
    expect(parsed.refused).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(fake.sent.filter((m) => m.type === "response.create")).toHaveLength(1);
    thinker.stop();
  });

  it("refuses a write whose quote the caller never said", async () => {
    const thinker = createLiveThinkerForCall({
      callId: CALL,
      leadId: LEAD,
      agencyId: baseLead().agencyId,
      direction: "inbound",
      agentInstructions: "You are the agency's assistant.",
      deployment: "gpt-5.6-luna",
      store: mockLeadStore,
    });
    const result = await thinker.call("write_quote_field", { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" });
    expect(result.ok).toBe(false);
    expect(result.endCall).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, refused: { code: expect.any(String) } });
    thinker.stop();
  });

  it("never throws when the dispatcher does", async () => {
    const dispatcher = { dispatch: async () => { throw new Error("boom"); } } as unknown as FlowDispatcher;
    const thinker = createLiveThinker({ deployment: "d", agentInstructions: "x", dispatcher });
    const result = await thinker.call("end_call", {});
    expect(result.ok).toBe(false);
    expect(result.refusedCode).toBe("run_failed");
  });
});

describe("the delegation follows the step guidance", () => {
  it("sends one session.update when the guidance changes and none when it repeats", async () => {
    const thinker = fakeThinker();
    let guidance = "Ask when the policy renews.";
    const { fake } = await started({ thinker, onCallerFinal: async () => guidance });
    const updates = () => fake.sent.filter((m) => m.type === "session.update");
    fake.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    expect(updates()).toHaveLength(1);
    const sent = updates()[0]!.session as { delegation: { responses: { instructions: string } } };
    expect(sent.delegation.responses.instructions).toContain("Ask when the policy renews.");
    expect(updates()[0]!.session).not.toHaveProperty("instructions");
    expect(toolTraces("thinker_delegation_updated")).toHaveLength(1);
    expect(typeof toolTraces("thinker_delegation_updated")[0]!.data.inputs).toBe("object");

    fake.emit({ type: "session.input_transcript.delta", delta: "Still here" });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    expect(updates()).toHaveLength(1);

    guidance = "Offer to book a producer.";
    fake.emit({ type: "session.input_transcript.delta", delta: "Sure" });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    expect(updates()).toHaveLength(2);
    // The speaker is still steered after the delegation update.
    const steerIndex = fake.sent.findIndex((m) => m.type === "session.instructions.append" && String(m.content).includes("Offer to book"));
    const updateIndex = fake.sent.findIndex((m, i) => m.type === "session.update" && i > fake.sent.indexOf(updates()[0]!));
    expect(updateIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeGreaterThan(updateIndex);
  });

  it("sends no session.update when a caller line brings no new guidance", async () => {
    const { fake } = await started({ thinker: fakeThinker(), onCallerFinal: async () => undefined });
    fake.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    await vi.advanceTimersByTimeAsync(GAP_MS + 5);
    expect(fake.sent.filter((m) => m.type === "session.update")).toHaveLength(0);
  });
});

describe("liveThinkerStatus and the texts", () => {
  it("is off when the variable is unset or off", () => {
    expect(liveThinkerStatus({})).toEqual({ enabled: false, tools: [] });
    expect(liveThinkerStatus({ [LIVE_THINKER_ENV]: "off" })).toEqual({ enabled: false, tools: [] });
    expect(liveThinkerStatus({ [LIVE_THINKER_ENV]: " OFF " })).toEqual({ enabled: false, tools: [] });
  });

  it("falls to the decision layer's default deployment on 'on' when no credential file is configured", () => {
    const status = liveThinkerStatus({ [LIVE_THINKER_ENV]: "on" });
    expect(status.enabled).toBe(true);
    expect(status.deployment).toBe(DEFAULT_DECISION_CHAT_DEPLOYMENT);
    expect(status.tools).toContain("write_quote_field");
    expect(status.tools).not.toContain("start_quote");
    expect(status.tools).not.toContain("check_carrier_appetite");
  });

  it("uses any other value as the deployment name", () => {
    expect(liveThinkerStatus({ [LIVE_THINKER_ENV]: "my-fast-model" }).deployment).toBe("my-fast-model");
  });

  it("thinkerInstructions carries the preamble, the agent instructions and the guidance line", () => {
    const text = thinkerInstructions("AGENT TEXT", "Ask for the renewal date.");
    expect(text).toContain("thinking half of a phone agent");
    expect(text).toContain("AGENT TEXT");
    expect(text).toContain("Current step guidance from the decision module: Ask for the renewal date.");
    expect(thinkerInstructions("AGENT TEXT")).not.toContain("Current step guidance");
  });

  it("the speaker note never asks for word for word repetition", () => {
    expect(THINKER_SPEAKER_NOTE).not.toMatch(/word for word|exactly/i);
    expect(THINKER_SPEAKER_NOTE).toContain("delegate");
  });
});
