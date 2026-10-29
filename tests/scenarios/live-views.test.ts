import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetActiveTree } from "../../src/decision/tree-source.js";
import { handle, setPlayIdleMs } from "../../src/server/dev-server.js";
import { getStartInteractiveCall, resetStartInteractiveCall, setPlayClock, setStartInteractiveCall } from "../../src/server/play-wiring.js";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { resetLeadStore, getLead } from "../../src/store/lead-store.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { recordStore } from "../../src/trace/index.js";
import { setFakePaceMs } from "../../src/server/fake-interactive.js";
import { align, buildStage, createView, eventsFor, ingest, latestCallId, layoutTree, summarize } from "../../src/server/live-view-core.js";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";

// These tests assume the stub tree. The dev server reads the tree when it loads, so set this before the first read.
vi.hoisted(() => {
  process.env.VOICE_HARNESS_DECISION_TREE = new URL("../../src/decision/stub-tree.json", import.meta.url).pathname;
});

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  setFakePaceMs(0);
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => {
  resetStartInteractiveCall();
  server.close();
});

// Play calls run the real gated path: a fixed clock inside calling hours, the flag on, fresh stores.
beforeEach(() => {
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetLeadStore();
  resetStartInteractiveCall();
  captureStartedCalls();
  startedCalls.clear();
  setAiCallingEnabled("agency-demo", true);
  setPlayClock({ now: () => new Date("2026-10-15T14:00:00.000Z") });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}
// The typed say route is gone; the voice socket calls the handle's say, so tests do the same.
const startedCalls = new Map<string, { say(text: string): Promise<unknown> }>();
const sayOn = (callId: string, text: string) => startedCalls.get(callId)!.say(text);
function captureStartedCalls(): void {
  const inner = getStartInteractiveCall()!;
  setStartInteractiveCall(async (args) => {
    const call = await inner(args);
    if (call.status !== "blocked") startedCalls.set(call.callId, call);
    return call;
  });
}
const eventsOf = (callId: string) => traceBus.history().filter((e) => e.callId === callId);

const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

const status = (method: string, path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

let seq = 0;
function ev(type: string, atMs: number | undefined, data: Record<string, unknown>, at = "2026-10-19T10:00:00.000Z"): TraceEvent {
  seq += 1;
  return { seq, recordSeq: seq, at, atMs, type, leadId: "lead-1", recordId: "call_x", channel: "call", callId: "call_x", data } as unknown as TraceEvent;
}

describe("views server", () => {
  it("serves the tree, the lead list and the shared script, and refuses a non-loopback host", async () => {
    const tree = await (await fetch(base + "/api/tree")).json();
    expect(tree.nodes.find((n: any) => n.id === tree.start)).toBeTruthy();
    expect(tree.dispositions.length).toBeGreaterThan(0);
    expect((await fetch(base + "/api/play/leads").then((r) => r.json())).length).toBeGreaterThan(0);
    const script = await fetch(base + "/live-view-core.js");
    expect(script.headers.get("content-type")).toContain("javascript");

    const bad = { host: `evil.example:${port}` };
    expect(await status("GET", "/api/tree", bad)).toBe(403);
    expect(await status("GET", "/live-view-core.js", bad)).toBe(403);
    expect(await status("POST", "/api/play/start", bad)).toBe(403);
    expect(await status("POST", "/api/play/call_x/hangup", bad)).toBe(403);
    expect(await status("POST", "/api/play/start", { host: `127.0.0.1:${port}`, origin: "http://evil.example" })).toBe(403);
  });

  it("refuses every play action when no gated start is installed", async () => {
    setStartInteractiveCall(null);
    for (const path of ["/api/play/start", "/api/play/call_x/hangup"]) {
      const r = await post(path, { leadId: "lead-1", direction: "inbound", text: "hi" });
      expect(r.status, path).toBe(503);
      expect(r.json.error).toBe("play_unavailable_until_gated");
    }
  });

  it("rejects bad play requests and unknown calls", async () => {
    expect((await post("/api/play/start", { leadId: "lead-1", direction: "sideways" })).status).toBe(400);
    expect((await post("/api/play/start", { leadId: "../etc", direction: "inbound" })).status).toBe(400);
    const unknown = await post("/api/play/start", { leadId: "nobody", direction: "inbound" });
    expect(unknown.status).toBe(409);
    expect(unknown.json).toEqual({ blocked: true, reason: "lead_not_found" });
    expect((await post("/api/play/call_nope/say", { text: "hi" })).status).toBe(404); // the typed say route no longer exists
    expect((await post("/api/play/call_nope/hangup")).status).toBe(404);
  });

  it("plays a lead end to end through the gated path, emitting the contract events in time order, and stores a record to replay", async () => {
    const started = await post("/api/play/start", { leadId: "lead-1", direction: "outbound" });
    expect(started.status).toBe(200);
    const callId = started.json.callId as string;
    for (const text of ["Yes, this is Jane", "I want a quote for my car", "It is a 2019 Honda", "no that is all"]) {
      await sayOn(callId, text);
    }
    // Reaching an ending ends the call and frees its slot, so the record closes by itself.
    await waitFor(() => eventsOf(callId).some((e) => e.type === "call_outcome"));
    expect(((await (await fetch(base + "/api/play/open")).json()) as any[]).some((c) => c.callId === callId)).toBe(false);

    const mine = eventsOf(callId);
    const kinds = new Set(mine.map((e) => e.type));
    for (const k of ["compliance_check", "transcript_partial", "transcript_final", "node_enter", "decision", "disposition", "judge_verdict", "judge_score", "tool_call", "call_outcome"]) {
      expect(kinds.has(k as any), k).toBe(true);
    }
    expect(mine.find((e) => e.type === "transcript_final")!.data.text).toMatch(/AI assistant/);
    expect(mine.every((e) => typeof e.atMs === "number" && e.leadId === "lead-1")).toBe(true);
    expect(mine.map((e) => e.atMs)).toEqual([...mine.map((e) => e.atMs)].sort((a, b) => a - b));
    const decision = mine.find((e) => e.type === "decision")!.data;
    for (const field of ["nodeId", "question", "answers", "answer", "confidence", "reason", "module", "minConfidence", "routed"]) {
      expect(decision, field).toHaveProperty(field);
    }

    const record = await (await fetch(`${base}/api/records/${callId}`)).json();
    const sorted = eventsFor(record.events, null);
    expect(summarize(sorted).disposition).toBe("quote_started");
    expect(summarize(sorted).verdicts.every((v: any) => v.allowed)).toBe(true);
    expect(summarize(sorted).score).not.toBeNull();
  });

  it("refuses a start with the flag off: 409 with the reason, no call id, nothing played", async () => {
    setAiCallingEnabled("agency-demo", false);
    const r = await post("/api/play/start", { leadId: "lead-1", direction: "inbound" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ blocked: true, reason: "ai_calling_disabled" });
    expect(startedCalls.size).toBe(0);
  });

  it("refuses an outbound start for a lead with no text agreement", async () => {
    const r = await post("/api/play/start", { leadId: "lead-3", direction: "outbound" });
    expect(r.status).toBe(409);
    expect(r.json.blocked).toBe(true);
  });

  it("records a spoken stop, ends the call, and refuses a second start", async () => {
    const started = await post("/api/play/start", { leadId: "lead-2", direction: "inbound" });
    const callId = started.json.callId as string;
    expect(eventsOf(callId).find((e) => e.type === "transcript_final")!.data.text).toMatch(/AI assistant/);
    await sayOn(callId, "please stop calling me");
    await waitFor(() => eventsOf(callId).some((e) => e.type === "call_outcome"));
    expect(eventsOf(callId).some((e) => e.type === "tool_call" && e.data.tool === "record_stop")).toBe(true);
    expect(getLead("lead-2")!.consentRevokedAt).toBeTruthy();
    const again = await post("/api/play/start", { leadId: "lead-2", direction: "inbound" });
    expect(again.status).toBe(409);
    expect(again.json.blocked).toBe(true);
  });
});

describe("play call lifecycle", () => {
  it("replaces an open play call on a second start for the same lead", async () => {
    const first = await post("/api/play/start", { leadId: "lead-2", direction: "inbound" });
    expect(first.status).toBe(200);
    const second = await post("/api/play/start", { leadId: "lead-2", direction: "inbound" });
    expect(second.status).toBe(200);
    expect(second.json.callId).not.toBe(first.json.callId);
    const open = await (await fetch(base + "/api/play/open")).json();
    expect(open).toHaveLength(1);
    expect(open[0].callId).toBe(second.json.callId);
    await post(`/api/play/${second.json.callId}/hangup`);
  });

  it("lists open play calls and hangup-all clears them", async () => {
    const a = await post("/api/play/start", { leadId: "lead-1", direction: "inbound" });
    const b = await post("/api/play/start", { leadId: "lead-2", direction: "inbound" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const open = await (await fetch(base + "/api/play/open")).json();
    expect(open).toHaveLength(2);
    const cleared = await post("/api/play/hangup-all");
    expect(cleared.status).toBe(200);
    expect(cleared.json.ended).toBe(2);
    expect(await (await fetch(base + "/api/play/open")).json()).toHaveLength(0);
  });

  it("ends an idle call as abandoned and frees its slot, and a hang-up ends it normally", async () => {
    setPlayIdleMs(30);
    try {
      const idle = (await post("/api/play/start", { leadId: "lead-2", direction: "inbound" })).json.callId as string;
      await waitFor(() => eventsOf(idle).some((e) => e.type === "call_outcome"));
      expect(eventsOf(idle).find((e) => e.type === "call_outcome")!.data.status).toBe("abandoned");
      expect(((await (await fetch(base + "/api/play/open")).json()) as any[]).some((c) => c.callId === idle)).toBe(false);
    } finally {
      setPlayIdleMs(5 * 60 * 1000);
    }
    const open = (await post("/api/play/start", { leadId: "lead-2", direction: "inbound" })).json.callId as string;
    expect((await post(`/api/play/${open}/hangup`)).status).toBe(200);
    expect(eventsOf(open).find((e) => e.type === "call_outcome")!.data.status).toBe("ai_handled");
    expect((await post(`/api/play/${open}/hangup`)).status).toBe(404);
  });

  it("keeps one clock for a record that spans a restart", async () => {
    const callId = (await post("/api/play/start", { leadId: "lead-1", direction: "inbound" })).json.callId as string;
    await new Promise((r) => setTimeout(r, 25));
    const before = eventsOf(callId).at(-1)!.atMs;
    traceBus.reset(); // a restart: counters and start times are forgotten, the file stays
    await sayOn(callId, "Yes this is Jane");
    const record = recordStore.read(callId)!;
    const afterRestart = record.events.filter((e) => e.type === "transcript_partial" && e.data.role === "caller")[0]!;
    expect(afterRestart.atMs).toBeGreaterThanOrEqual(before + 20);
    expect(record.events.map((e) => e.atMs)).toEqual([...record.events.map((e) => e.atMs)].sort((a, b) => a - b));
    await post(`/api/play/${callId}/hangup`);
  });
});

describe("live view logic", () => {
  it("orders events by atMs even when they arrive late, and ignores a repeated event", () => {
    const view = createView();
    const late = ev("tool_call", 50, { tool: "a", success: true });
    const early = ev("tool_call", 10, { tool: "b", success: true });
    ingest(view, late);
    ingest(view, early);
    expect(ingest(view, early)).toBe(false);
    expect(eventsFor(view.events.values(), "call_x").map((e) => e.data.tool)).toEqual(["b", "a"]);
    expect(latestCallId(view)).toBe("call_x");
  });

  it("derives time from the ISO stamp for records written before atMs existed", () => {
    const a = ev("tool_call", undefined, { tool: "a" }, "2026-10-19T10:00:02.000Z");
    const b = ev("tool_call", undefined, { tool: "b" }, "2026-10-19T10:00:00.000Z");
    const sorted = eventsFor([a, b], null);
    expect(sorted.map((e) => [e.data.tool, e.ms])).toEqual([["b", 0], ["a", 2000]]);
  });

  it("lines each trace row up with the transcript line it belongs to, whatever order they arrive in", () => {
    const events = [
      ev("transcript_partial", 100, { role: "caller", text: "I want a", turnIndex: 1 }),
      ev("transcript_final", 300, { role: "caller", text: "I want a quote", turnIndex: 1 }),
      ev("decision", 350, { answer: "quote", confidence: 0.9, minConfidence: 0.6, module: "m", reason: "r", routed: "proceed" }),
      ev("tool_call", 20, { tool: "read_lead_context", success: true, durationMs: 4 }),
      ev("transcript_final", 500, { role: "agent", text: "Sure.", turnIndex: 2 }),
      ev("judge_verdict", 520, { action: "book", allowed: false, reason: "no", scores: [] }),
    ];
    const shapes = (list: TraceEvent[]) =>
      align(eventsFor(list, "call_x")).map((g) => [g.line?.text ?? null, g.line?.final ?? null, g.rows.map((r) => r.event.type)]);
    const expected = [
      [null, null, ["tool_call"]],
      ["I want a quote", true, ["decision"]],
      ["Sure.", true, ["judge_verdict"]],
    ];
    expect(shapes(events)).toEqual(expected);
    expect(shapes([...events].reverse())).toEqual(expected);
    // A late partial never turns a finished line back into a partial.
    expect(shapes([...events, ev("transcript_partial", 150, { role: "caller", text: "I want", turnIndex: 1 })])).toEqual(expected);
    const rows = align(eventsFor(events, "call_x")).flatMap((g) => g.rows);
    expect(rows.find((r) => r.kind === "judge")!.bad).toBe(true);
  });

  it("reads the legacy turn event as a final transcript line and marks failed tool calls", () => {
    const groups = align(eventsFor([
      ev("turn", 10, { role: "agent", text: "Hello", turnIndex: 0, spoken: true }),
      ev("tool_call", 20, { tool: "save_message", success: false, reason: "error", durationMs: 7 }),
    ], null));
    expect(groups[0]!.line).toMatchObject({ text: "Hello", final: true });
    expect(groups[0]!.rows[0]).toMatchObject({ bad: true });
    expect(groups[0]!.rows[0]!.text).toContain("FAILED");
  });

  it("lays out the served tree with every node placed", async () => {
    const tree = await (await fetch(base + "/api/tree")).json();
    const layout = layoutTree(tree);
    expect(layout.placed).toHaveLength(tree.nodes.length);
  });

  it("builds the live stage with per-answer scores at the current node", () => {
    const tree = {
      start: "n1",
      dispositions: [],
      nodes: [
        { id: "n1", label: "Ask", question: "What?", bars: { quote: 0.6, unclear: 0 }, edges: [{ answer: "quote", to: "n2" }, { answer: "unclear", to: null }] },
        { id: "n2", label: "Next", edges: [] },
      ],
    };
    const sorted = eventsFor([
      ev("node_enter", 0, { nodeId: "n1", label: "Ask" }),
      ev("decision", 50, {
        nodeId: "n1", answer: "quote", routed: "proceed", module: "jev-mock",
        scores: [{ answer: "quote", confidence: 0.88 }, { answer: "unclear", confidence: 0.05 }],
      }),
    ], null);
    const stage = buildStage(tree, sorted, summarize(sorted));
    expect(stage.label).toBe("Ask");
    expect(stage.branches.find((b) => b.answer === "quote")).toMatchObject({ taken: true, modelConfidence: 0.88 });
  });
});

describe("page safety", () => {
  it("never uses innerHTML, outerHTML or insertAdjacentHTML", () => {
    for (const file of ["live-view-core.js", "dev-server.ts", "fake-interactive.ts"]) {
      const text = readFileSync(new URL(`../../src/server/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});

describe("summarize keeps the tree decision as the latest decision", () => {
  it("a live judge decision event does not replace the tree decision", () => {
    const at = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, ms: seq, type, data }) as any;
    const sorted = [
      at(1, "decision", { nodeId: "booking.offer", answer: "accepts_time", confidence: 0.9 }),
      at(2, "decision", { kind: "live_judge", action: "book", allowed: true }),
    ];
    expect(summarize(sorted).decision).toMatchObject({ nodeId: "booking.offer", answer: "accepts_time" });
  });
});
