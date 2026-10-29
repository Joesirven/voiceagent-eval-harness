import { chmodSync, mkdtempSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { listScenarios, runScenario } from "../../src/scenarios/trial-scenarios.js";
import { handle } from "../../src/server/dev-server.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { DEFAULT_RECORDS_DIR, narrate, RecordStore, recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const OUTSIDE_WINDOW = "2026-10-15T02:00:00.000Z";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "trace-test-"));
  recordStore.setDir(tempDir);
  traceBus.reset();
  resetHarnessConfig();
  resetModuleRegistry();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
});

function onDisk(recordId: string): TraceEvent[] {
  return recordStore.read(recordId)!.events;
}

describe("every scenario leaves a complete trace", () => {
  for (const { id } of listScenarios()) {
    it(`${id}: numbered 1..n with no gaps, identified, and ends with an outcome`, async () => {
      const run = await runScenario(id);
      expect(run.recordIds.length).toBeGreaterThan(0);
      // Order across the whole process: consecutive numbers, none missing.
      const seqs = traceBus.history().map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      for (const recordId of run.recordIds) {
        const record = recordStore.read(recordId)!;
        expect(record.events.map((e) => e.recordSeq)).toEqual(record.events.map((_, i) => i + 1));
        for (const e of record.events) {
          expect(e.leadId).toBe("lead-1");
          expect(Boolean(e.callId) !== Boolean(e.messageId)).toBe(true);
          expect(Number.isNaN(Date.parse(e.at))).toBe(false);
        }
        const last = record.events.at(-1)!;
        expect(record.kind === "call" ? last.type === "call_outcome" : last.type === "text").toBe(true);
      }
    });
  }

  it("a recognized inbound call shows every check, tool call, turn, and the handoff", async () => {
    const run = await runScenario("recognized-inbound");
    const events = onDisk(run.recordIds[0]!);
    const names = events.filter((e) => e.type === "compliance_check").map((e) => e.data.check);
    expect(names).toEqual([
      "lead_found",
      "ai_calling_enabled",
      "voice_module_available",
      "suppression",
      "quiet_hours",
      "one_call_at_a_time",
      "duplicate_guard",
      "disclosure_first",
    ]);
    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools.map((e) => e.data.tool)).toEqual(
      expect.arrayContaining(["start_inbound_call", "read_lead_context", "write_quote_field", "append_handoff_note", "end_call"]),
    );
    for (const t of tools) {
      expect(typeof t.data.durationMs).toBe("number");
      expect(t.data.success).toBe(true);
      expect(t.data.inputs).toBeDefined();
    }
    expect(events.some((e) => e.type === "turn")).toBe(true);
    expect(events.some((e) => e.type === "handoff")).toBe(true);
    const record = recordStore.read(run.recordIds[0]!)!;
    expect(record.outcome?.status).toBe("ai_handled");
    expect(record.handoffNote).toBeDefined();
    expect(record.transcript[0]?.text).toContain("AI");
    expect(record.transcript.every((t) => typeof t.at === "string")).toBe(true);
  });

  it("a blocked call records which check blocked and why, then ends with an outcome", async () => {
    const run = await runScenario("quiet-hours");
    const callRecord = recordStore.read(run.recordIds.find((id) => id.startsWith("call_"))!)!;
    const blocked = callRecord.events.filter((e) => e.type === "compliance_check" && e.data.passed === false);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.data.check).toBe("quiet_hours");
    expect(callRecord.outcome?.status).toBe("blocked");
    expect(callRecord.outcome?.reason).toContain("outside_quiet_hours");
  });

  it("a run that throws still ends with a failed outcome and no error text in the reason", async () => {
    getModuleRegistry().setEnabled("vapi", true);
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    await expect(h.runInbound("no-such-lead", "+15550100", { idempotencyKey: "x" })).rejects.toThrow();
    const [record] = recordStore.list();
    expect(record!.events.at(-1)!.type).toBe("call_outcome");
    expect(record!.outcome?.status).toBe("failed");
    expect(record!.events.map((e) => e.recordSeq)).toEqual(record!.events.map((_, i) => i + 1));
  });
});

describe("records survive a restart", () => {
  it("are written, then read back by a fresh store, and a text thread keeps counting", async () => {
    seedLead(baseLead());
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    getModuleRegistry().setEnabled("vapi", true);
    await h.sendText("lead-1", "First text", "k1");
    traceBus.reset(); // the process restarts: counters and history are gone
    await h.sendText("lead-1", "Second text", "k2");
    const fresh = new RecordStore();
    fresh.setDir(tempDir);
    const thread = fresh.list().find((r) => r.kind === "text")!;
    expect(thread.texts.map((t) => t.status)).toEqual(["recorded", "recorded"]);
    expect(thread.texts.map((t) => t.body)).toEqual(["First text", "Second text"]);
    expect(thread.events.map((e) => e.recordSeq)).toEqual(thread.events.map((_, i) => i + 1));
    expect(new Set(thread.texts.map((t) => t.messageId)).size).toBe(2);
  });

  it("a half-written last line after a crash does not hide the rest", async () => {
    const run = await runScenario("duplicate-webhook");
    const file = join(tempDir, `${run.recordIds[0]}.jsonl`);
    const before = recordStore.read(run.recordIds[0]!)!.events.length;
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, '{"line":"event","type":"tur');
    expect(recordStore.read(run.recordIds[0]!)!.events.length).toBe(before);
  });

  it("the durable transcript holds only the spoken part of an interrupted agent turn", async () => {
    seedLead(baseLead());
    getModuleRegistry().setEnabled("vapi", true);
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    const r = await h.runInbound("lead-1", "+15550143", {
      idempotencyKey: "barge",
      callerUtterances: ["Hello"],
      bargeIn: { interruptAtTurnIndex: 1, spokenAgentPrefix: "I see your rec" },
    });
    const record = recordStore.read(r.recordId!)!;
    expect(record.transcript.map((t) => t.text)).toContain("I see your rec");
    const spoken = record.transcript.filter((t) => t.role !== "system").map((t) => t.text).join("\n");
    expect(spoken).not.toContain("How can I help you today");
  });
});

describe("one timeline per lead", () => {
  it("merges texts and calls in time order, with a plain sentence for each meaningful step", async () => {
    seedLead(baseLead());
    getModuleRegistry().setEnabled("vapi", true);
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    await h.sendText("lead-1", "Hi Jane, calling at 10", "t1");
    await h.runOutbound("lead-1", "", { idempotencyKey: "o1", scheduledReason: "text_agreed_callback", callerUtterances: ["Hello"] });
    await h.sendText("lead-1", "Thanks for talking", "t2");
    const timeline = recordStore.timeline("lead-1");
    expect(timeline.records.map((r) => r.kind).sort()).toEqual(["call", "text"]);
    const ats = timeline.items.map((i) => i.at);
    expect([...ats].sort()).toEqual(ats);
    const channels = timeline.items.map((i) => i.channel);
    expect(channels.indexOf("sms")).toBeLessThan(channels.indexOf("call"));
    expect(channels.lastIndexOf("sms")).toBeGreaterThan(channels.lastIndexOf("call"));
    const plain = timeline.items.map((i) => i.plain).filter(Boolean);
    expect(plain).toContain("Recorded a text for Jane; no sender is connected, so nothing was sent.");
    expect(plain).toContain("Called Jane; the call has ended.");
    expect(recordStore.timeline("someone-else").items).toEqual([]);
  });
});

describe("the plain-language pane never shows raw inputs", () => {
  it("keeps phone numbers, utterances, bodies, evidence and error text out of every sentence", async () => {
    const SENTINELS = ["+15550177", "SENTINELUTTERANCE", "SENTINELBODY", "SENTINELERROR", "SENTINELREASON", "2019"];
    getModuleRegistry().setEnabled("vapi", true);
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);

    seedLead(baseLead({ phone: "+15550177", name: "Maria Lopez" }));
    await h.runInbound("lead-1", "+15550143", {
      idempotencyKey: "i1",
      callerUtterances: ["SENTINELUTTERANCE I need a quote", "I drive a 2019 SENTINELUTTERANCE"],
    });
    await h.runOutbound("lead-1", "", { idempotencyKey: "o1", scheduledReason: "text_agreed_callback", callerUtterances: ["SENTINELUTTERANCE quote"] });
    await h.sendText("lead-1", "SENTINELBODY", "s1");
    await h.receiveText("lead-1", "STOP", "r1");
    await h.sendText("lead-1", "SENTINELBODY again", "s2");
    // A store that reports a free-text reach reason and a provider whose start fails.
    seedLead(baseLead({ id: "lead-2", name: "Sam" }));
    const reaching = { ...mockLeadStore, finalReachCheck: async () => ({ allowed: false, reason: "SENTINELREASON" }) };
    await new CallHarness(clockAt(IN_WINDOW), reaching).sendText("lead-2", "SENTINELBODY", "s3");
    seedLead(baseLead({ id: "lead-3", name: "Pat", phone: "+15550177" }));
    getModuleRegistry().get("vapi").setEnabled(false);
    getModuleRegistry().setEnabled("bland", true);
    getModuleRegistry().select("bland");
    const broken = getModuleRegistry().activeModule()!;
    broken.startOutboundCall = async () => {
      throw new Error("SENTINELERROR +15550177");
    };
    await h.runOutbound("lead-3", "", { idempotencyKey: "o3", scheduledReason: "text_agreed_callback" });

    const events = traceBus.history();
    const sentences = events.map(narrate).filter((s): s is string => s !== null);
    expect(sentences.length).toBeGreaterThan(8);
    expect(sentences).toContain("Did not text Maria: they are on the stop list.");
    expect(sentences).toContain("Maria texted a request to stop.");
    expect(sentences).toContain("Recorded vehicle year from what Maria said.");
    expect(sentences).toContain("Could not start the call with Pat: the voice service would not connect.");
    expect(sentences.some((s) => s.startsWith("Did not text Sam: the agency's own contact rules"))).toBe(true);
    const timelineSentences = ["lead-1", "lead-2", "lead-3"].flatMap((id) =>
      recordStore.timeline(id).items.map((i) => i.plain).filter((p): p is string => p !== null),
    );
    for (const sentence of [...sentences, ...timelineSentences]) {
      for (const secret of SENTINELS) expect(sentence).not.toContain(secret);
    }
    // The developer trace does keep the raw inputs.
    expect(JSON.stringify(events)).toContain("SENTINELBODY");
  });
});

describe("live events and the read API", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  function readEvents(until: (text: string) => boolean): Promise<string> {
    const port = (server.address() as AddressInfo).port;
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
          if (until(text)) {
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on("error", (err) => (until("") ? resolve("") : reject(err)));
      req.end();
      setTimeout(() => {
        req.destroy();
        reject(new Error("timed out waiting for events"));
      }, 5000).unref();
    });
  }

  it("streams events as they happen with a plain sentence beside each", async () => {
    getModuleRegistry().setEnabled("vapi", true);
    const streaming = readEvents((t) => t.includes("Did not call Jane"));
    await new Promise((r) => setTimeout(r, 50));
    await fetch(base + "/api/scenarios/stop-suppression/run", { method: "POST", body: "{}" });
    const text = await streaming;
    const frames = text.split("\n\n").filter((f) => f.includes("data: "));
    const parsed = frames.map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
    expect(parsed.every((p) => p.event.seq > 0)).toBe(true);
    expect(parsed.some((p) => p.plain === "Did not call Jane: they are on the stop list.")).toBe(true);
    expect(parsed.some((p) => p.plain === null && p.event.type === "compliance_check")).toBe(true);
  });

  it("replays recent events to a page that connects late", async () => {
    await fetch(base + "/api/scenarios/quiet-hours/run", { method: "POST", body: "{}" });
    const text = await readEvents((t) => t.includes("outside calling hours"));
    expect(text).toContain("Did not call Jane: it is outside calling hours where they live.");
  });

  it("serves records and a lead timeline", async () => {
    const run = await (await fetch(base + "/api/scenarios/recognized-inbound/run", { method: "POST", body: "{}" })).json();
    const record = await (await fetch(`${base}/api/records/${run.recordIds[0]}`)).json();
    expect(record.transcript.length).toBeGreaterThan(2);
    expect((await fetch(`${base}/api/records/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/records/..%2Fetc`)).status).toBe(404);
    const timeline = await (await fetch(`${base}/api/leads/lead-1/timeline`)).json();
    expect(timeline.items.length).toBeGreaterThan(5);
    expect((await (await fetch(`${base}/api/records`)).json()).length).toBeGreaterThan(0);
  });

  it("the front end never injects markup and listens to the event stream", () => {
    const sources = webSources();
    expect(sources.length).toBeGreaterThan(5);
    for (const [file, text] of sources) expect(text, file).not.toMatch(/innerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/);
    expect(readFileSync(join(__dirname, "../../web/src/lib/live.ts"), "utf8")).toContain("/api/events");
  });
});

function webSources(dir = join(__dirname, "../../web/src")): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d): Array<[string, string]> => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return webSources(full);
    return /\.(tsx?|css)$/.test(d.name) && !/\.test\./.test(d.name) ? [[full, readFileSync(full, "utf8")]] : [];
  });
}

describe("purge", () => {
  it("removes every record and the directory", async () => {
    await runScenario("recognized-inbound");
    await runScenario("quiet-hours");
    expect(readdirSync(tempDir).length).toBeGreaterThan(1);
    const removed = recordStore.purge();
    expect(removed).toBeGreaterThan(1);
    expect(existsSync(tempDir)).toBe(false);
    expect(recordStore.list()).toEqual([]);
    expect(recordStore.timeline("lead-1").items).toEqual([]);
  });

  it("deletes only files it wrote: foreign files survive, even lookalikes", async () => {
    await runScenario("quiet-hours");
    writeFileSync(join(tempDir, "keep.jsonl"), '{"line":"meta"}\n');
    writeFileSync(join(tempDir, "notes.txt"), "x");
    writeFileSync(join(tempDir, "call_lookalike.jsonl"), '{"not":"a meta line"}\n');
    writeFileSync(join(tempDir, "text_empty.jsonl"), "");
    recordStore.purge();
    expect(readdirSync(tempDir).sort()).toEqual(["call_lookalike.jsonl", "keep.jsonl", "notes.txt", "text_empty.jsonl"]);
  });

  it("the repository-root data directory is gitignored", () => {
    expect(readFileSync(join(__dirname, "../../.gitignore"), "utf8")).toMatch(/^\/data\/$/m);
  });
});

describe("review follow-ups", () => {
  it("never stores raw error text, only a reason code", async () => {
    seedLead(baseLead({ id: "lead-9", phone: "+15550177" }));
    getModuleRegistry().setEnabled("vapi", true);
    getModuleRegistry().activeModule()!.startOutboundCall = async () => {
      throw new Error("SENTINELERROR +15550177");
    };
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    await h.runOutbound("lead-9", "", { idempotencyKey: "e1", scheduledReason: "text_agreed_callback" });
    const text = readdirSync(tempDir).map((f) => readFileSync(join(tempDir, f), "utf8")).join("");
    expect(text).not.toContain("SENTINELERROR");
    const tool = recordStore.list()[0]!.events.find((e) => e.type === "tool_call" && e.data.success === false)!;
    expect(tool.data.reason).toBe("error");
    expect(JSON.stringify(traceBus.history())).not.toContain("SENTINELERROR");
  });

  it("keeps records private to the owner", async () => {
    const dir = join(tempDir, "fresh");
    recordStore.setDir(dir);
    await runScenario("quiet-hours");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  it("the default directory sits under the repository root, whatever the working directory", () => {
    expect(DEFAULT_RECORDS_DIR).toBe(join(__dirname, "../../data/records"));
  });

  it("an unreadable record falls back to zero instead of throwing", () => {
    writeFileSync(join(tempDir, "call_broken.jsonl"), "");
    
    chmodSync(join(tempDir, "call_broken.jsonl"), 0o000);
    expect(recordStore.countEvents("call_broken")).toBe(0);
    chmodSync(join(tempDir, "call_broken.jsonl"), 0o600);
  });

  it("a received STOP text ends with a final status after the stop is recorded", async () => {
    seedLead(baseLead());
    const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
    await h.receiveText("lead-1", "STOP", "r1");
    const thread = recordStore.list().find((r) => r.kind === "text")!;
    const last = thread.events.at(-1)!;
    expect(last.type).toBe("text");
    expect(last.data.status).toBe("stop_recorded");
    const names = thread.events.map((e) => e.data.tool ?? e.data.status);
    expect(names.indexOf("record_stop")).toBeLessThan(names.indexOf("stop_recorded"));
  });
});
