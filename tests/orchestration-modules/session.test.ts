import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAgentSystemInstruction, PERSONA_TRUTH_MARKERS } from "../../src/modules/agent-instructions.js";
import { OrchestrationRegistry, OrchestrationSession, OwnInfrastructureModule, PipecatModule,
  type DecisionRuntime, type ErrorCode, type OrchestrationModule, type OrchestrationTransport, type SessionConfig } from "../../src/orchestration-modules/index.js";

const config: SessionConfig = { orchestrationId: "own-infrastructure", mode: "simulator", input: "text",
  voiceProviderId: "azure-gpt-live", decisionModelId: "deterministic-fixture", promptSetupId: "fixture",
  decisionRoute: "deterministic", configurationRevision: "revision-1" };
const fixturePacket = {
  leadId: "lead-fixture", name: "Fixture Lead", agencyId: "agency-1", phone: "5550100",
  priorCallSummaries: [] as string[], quoteFields: {}, consentSnapshot: {},
};
const sessionOptions = {
  systemInstruction: buildAgentSystemInstruction("fixture", {
    leadFirstName: "Fixture", direction: "outbound", disclosure: "Test disclosure.",
  }, fixturePacket),
};
const decision: DecisionRuntime = { route: "deterministic", reply: async (text) => `reply:${text}` };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixtureModule(patch: Partial<OrchestrationTransport>): OrchestrationModule {
  const base = new OwnInfrastructureModule();
  return { id: base.id, capabilities: () => base.capabilities(), createTransport: () => ({ ...base.createTransport(), ...patch }) };
}

describe("orchestration session contract", () => {
  it.each(["live", "simulator"] as const)("uses the same text lifecycle for %s", async (mode) => {
    const session = new OrchestrationSession(new OwnInfrastructureModule(), { ...config, mode }, decision, sessionOptions);
    await session.start();
    expect(await session.say("hello")).toBe("reply:hello");
    await session.end(); await session.end();
    const events = session.events();
    expect(events.map((event) => event.type)).toEqual(["starting", "started", "caller_text", "agent_text", "ending", "ended"]);
    for (const [index, event] of events.entries()) {
      expect(event.sequence).toBe(index + 1);
      expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
      expect(event.snapshotId).toBe(session.snapshot.snapshotId);
      expect(event.traceId).toBe(session.traceId);
      expect(event.sessionId).toBe(session.sessionId);
    }
    expect(session.state).toBe("ended");
    await expect(session.say("late")).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("orders queued turns and drains before end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, {
      route: "deterministic", reply: async (text) => { seen.push(text); await gate; return text; },
    }, sessionOptions);
    await session.start();
    const first = session.say("one"); const second = session.say("two"); const ending = session.end();
    await tick(); expect(seen).toEqual(["one"]);
    await expect(session.say("three")).rejects.toMatchObject({ code: "invalid_state" });
    release();
    expect(await Promise.all([first, second])).toEqual(["one", "two"]);
    await ending;
    expect(session.events().map((event) => event.type)).toEqual(["starting", "started", "caller_text", "agent_text", "caller_text", "agent_text", "ending", "ended"]);
  });
  it("captures selection and identifiers per session", async () => {
    const registry = new OrchestrationRegistry([new OwnInfrastructureModule(), new PipecatModule({ pythonPath: "/missing/python" })]);
    const copy = { ...config };
    const session = registry.createSession(copy, decision, sessionOptions);
    registry.select("pipecat"); copy.promptSetupId = "changed";
    expect(() => registry.createSession({ ...copy, orchestrationId: undefined }, decision, sessionOptions)).toThrow("orchestration_unavailable");
    expect(session.snapshot.orchestrationId).toBe("own-infrastructure");
    expect(session.snapshot.promptSetupId).toBe("fixture");
    expect(Object.isFrozen(session.snapshot)).toBe(true);
    await session.start(); expect(await session.say("still own")).toBe("reply:still own"); await session.end();
    expect(session.snapshot.snapshotId).not.toBe(new OrchestrationSession(new OwnInfrastructureModule(), copy, decision, sessionOptions).snapshot.snapshotId);
  });
  it("refuses unsupported audio instead of selecting another adapter", () => {
    expect(() => new OrchestrationSession(new OwnInfrastructureModule(), { ...config, input: "audio", mode: "live" }, decision, sessionOptions)).toThrow("orchestration_unsupported_capability");
  });
  it("rejects mismatched model route and invalid configuration", () => {
    expect(() => new OrchestrationSession(new OwnInfrastructureModule(), { ...config, decisionRoute: "azure-foundry" }, decision, sessionOptions)).toThrow("orchestration_invalid_config");
    expect(() => new OrchestrationSession(new OwnInfrastructureModule(), { ...config, promptSetupId: "" }, decision, sessionOptions)).toThrow("orchestration_invalid_config");
    expect(() => new OrchestrationSession(new OwnInfrastructureModule(), config, decision, { systemInstruction: "revealMap:{}" })).toThrow("orchestration_invalid_config");
  });
  it("passes the shared system instruction into DecisionContext on every reply", async () => {
    let seen = "";
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, {
      route: "deterministic", reply: async (_, context) => { seen = context.systemInstruction; return "ok"; },
    }, sessionOptions);
    await session.start();
    await session.say("ping");
    expect(seen).toBe(sessionOptions.systemInstruction);
    expect(seen).toBe(session.systemInstruction);
    await session.end();
  });
  it("omits extra configuration properties from snapshots", () => {
    const session = new OrchestrationSession(new OwnInfrastructureModule(), { ...config, privateField: "sentinel" } as SessionConfig, decision, sessionOptions);
    expect(JSON.stringify(session.snapshot)).not.toContain("sentinel");
  });
  it("cancels in-flight and queued turns without late output", async () => {
    let release!: (text: string) => void;
    let signal!: AbortSignal;
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, { route: "deterministic", reply: async (_, context) => {
      signal = context.signal; return new Promise((resolve) => { release = resolve; });
    } }, sessionOptions);
    await session.start();
    const first = session.say("one"); const second = session.say("two");
    const rejected = Promise.allSettled([first, second]);
    await tick(); await session.cancel(); await session.cancel();
    expect(signal.aborted).toBe(true);
    expect((await rejected).every((result) => result.status === "rejected")).toBe(true);
    release("too late"); await tick();
    expect(session.events().map((event) => event.type)).toEqual(["starting", "started", "caller_text", "cancelled"]);
  });
  it("cancels startup and suppresses a late ready result", async () => {
    let release!: () => void;
    const session = new OrchestrationSession(fixtureModule({ open: () => new Promise((resolve) => { release = resolve; }) }), config, decision, sessionOptions);
    const starting = session.start(); const rejected = expect(starting).rejects.toMatchObject({ code: "cancelled" });
    await tick(); await session.cancel(); await rejected; release(); await tick();
    expect(session.events().map((event) => event.type)).toEqual(["starting", "cancelled"]);
  });
  it("bounds a hung decision and emits a fixed error", async () => {
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, { route: "deterministic", reply: () => new Promise(() => {}) }, { ...sessionOptions, timeoutMs: 15 });
    await session.start(); await expect(session.say("hello")).rejects.toMatchObject({ code: "timeout" });
    expect(session.state).toBe("failed"); expect(session.events().at(-1)).toMatchObject({ type: "error", code: "timeout" });
  });
  it("sanitizes decision failures without creating mutation or judge outcomes", async () => {
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, { route: "deterministic", reply: async () => { throw new Error("private-sentinel"); } }, sessionOptions);
    await session.start(); await expect(session.say("hello")).rejects.toThrow("orchestration_provider_failed");
    expect(JSON.stringify(session.events())).not.toContain("private-sentinel");
    expect(session.events().filter((event) => event.type === "error")).toHaveLength(1);
  });
  it("handles empty replies, failed start and failed close explicitly", async () => {
    const empty = new OrchestrationSession(new OwnInfrastructureModule(), config, { route: "deterministic", reply: async () => "" }, sessionOptions);
    await empty.start(); await expect(empty.say("hello")).rejects.toMatchObject({ code: "protocol_error" });
    for (const method of ["open", "close"] as const) {
      const session = new OrchestrationSession(fixtureModule({ [method]: async () => { throw new Error("private-sentinel"); } }), config, decision, sessionOptions);
      if (method === "open") await expect(session.start()).rejects.toThrow("orchestration_provider_failed");
      else { await session.start(); await expect(session.end()).rejects.toThrow("orchestration_provider_failed"); }
      expect(session.state).toBe("failed");
    }
  });
  it("records unsolicited runtime failure while idle", async () => {
    let fail!: (code: ErrorCode) => void;
    const session = new OrchestrationSession(fixtureModule({ open: async (_, onFailure) => { fail = onFailure; } }), config, decision, sessionOptions);
    await session.start(); fail("provider_failed"); await tick();
    expect(session.state).toBe("failed");
    expect(session.events().at(-1)).toMatchObject({ type: "error", code: "provider_failed" });
    await expect(session.say("late")).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("keeps observer and returned history mutations out of session state", async () => {
    const session = new OrchestrationSession(new OwnInfrastructureModule(), config, decision, { ...sessionOptions, onEvent: () => { throw new Error("observer"); } });
    await session.start(); await session.say("hello"); await session.end();
    (session.events()[0] as { type: string }).type = "changed";
    expect(session.events()[0].type).toBe("starting");
  });
  it("keeps simulator persona truth markers out of agent-bound instruction helpers", () => {
    const source = readFileSync(new URL("../../src/modules/agent-instructions.ts", import.meta.url), "utf8");
    const body = source.replace(/PERSONA_TRUTH_MARKERS[\s\S]*?\] as const;/, "");
    for (const marker of PERSONA_TRUTH_MARKERS) {
      expect(body).not.toContain(marker);
    }
  });
});

const pythonPath = process.env.CRM_PIPECAT_PYTHON;
describe.skipIf(!pythonPath)("real pinned Pipecat subprocess", () => {
  const module = () => new PipecatModule({ pythonPath: pythonPath! });
  const pipecatConfig = { ...config, orchestrationId: "pipecat" as const };
  it("executes actual frame processors and drains on graceful end", async () => {
    const seen: string[] = [];
    const session = new OrchestrationSession(module(), pipecatConfig, { route: "deterministic", reply: async (text) => { seen.push(text); return `frame reply:${text}`; } }, sessionOptions);
    await session.start();
    expect(await session.say("synthetic lead")).toBe("frame reply:synthetic lead");
    expect(await session.say("second turn")).toBe("frame reply:second turn");
    await session.end();
    expect(seen).toEqual(["synthetic lead", "second turn"]);
    expect(session.events().map((event) => event.type)).toEqual(["starting", "started", "caller_text", "agent_text", "caller_text", "agent_text", "ending", "ended"]);
  }, 30_000);
  it("propagates CancelFrame during an actual pending decision", async () => {
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const session = new OrchestrationSession(module(), pipecatConfig, { route: "deterministic", reply: async () => { entered(); return new Promise(() => {}); } }, sessionOptions);
    await session.start(); const speaking = session.say("cancel me");
    const rejected = expect(speaking).rejects.toMatchObject({ code: "cancelled" });
    await entry; await session.cancel(); await rejected;
    expect(session.state).toBe("cancelled");
    expect(session.events().at(-1)?.type).toBe("cancelled");
    expect(session.events().some((event) => event.type === "agent_text")).toBe(false);
  }, 30_000);
  it("fails a real decision bridge and never falls back", async () => {
    const session = new OrchestrationSession(module(), pipecatConfig, { route: "deterministic", reply: async () => { throw new Error("private-sentinel"); } }, sessionOptions);
    await session.start(); await expect(session.say("error")).rejects.toThrow("orchestration_provider_failed");
    expect(session.state).toBe("failed"); expect(JSON.stringify(session.events())).not.toContain("private-sentinel");
  }, 30_000);
  it("reports an executable without Pipecat as an explicit runtime failure", async () => {
    const session = new OrchestrationSession(new PipecatModule({ pythonPath: "/usr/bin/false" }), pipecatConfig, decision, sessionOptions);
    await expect(session.start()).rejects.toThrow("orchestration_provider_failed");
    expect(session.state).toBe("failed");
  });
});
