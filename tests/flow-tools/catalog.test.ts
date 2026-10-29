import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_FILE,
  catalogProblems,
  FLOW_TOOL_CATALOG,
  flowToolCounts,
  isDispatched,
  isRunnable,
  loadFlowToolCatalog,
  validateToolArguments,
  type FlowTool,
} from "../../src/flow-tools/catalog.js";
import { RuleBasedPostCallJudge } from "../../src/judge/post-call.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import { JUDGE_ACTIONS, type JudgeAction, type JudgePayload } from "../../src/judge/types.js";
import { isHardToUndo } from "../../src/judging/live-questions.js";
import type { TraceEvent } from "../../src/trace/events.js";
import type { HarnessRecord } from "../../src/trace/records.js";

/** Build step 2 closed every gap: each list stays empty, so a new gap fails the test. */
const WAITING_ON_STEP_2 = {
  notInJudgeActions: [] as string[],
  notHardToUndo: [] as string[],
  traceNotJudged: [] as string[],
};

const rawCatalog = () => JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as { templates: Record<string, string>; tools: Record<string, any>[] };
const tool = (name: string): FlowTool => {
  const found = FLOW_TOOL_CATALOG.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no catalog tool ${name}`);
  return found;
};
const isJudgeAction = (action: string): action is JudgeAction => (JUDGE_ACTIONS as readonly string[]).includes(action);

/** Applies one change to a fresh copy of the shipped catalog and returns its problems. */
function problemsAfter(change: (raw: ReturnType<typeof rawCatalog>) => void): string[] {
  const raw = rawCatalog();
  change(raw);
  return catalogProblems(raw);
}
const entry = (raw: ReturnType<typeof rawCatalog>, name: string) => raw.tools.find((t) => t.name === name)!;

describe("the shipped catalog", () => {
  it("passes its own rules and loads", () => {
    expect(catalogProblems(rawCatalog())).toEqual([]);
    expect(() => loadFlowToolCatalog()).not.toThrow();
    expect(FLOW_TOOL_CATALOG.tools).toHaveLength(25);
  });

  it("keeps the trace names the specification settles", () => {
    expect(tool("end_call").trace).toBe("record_disposition");
    expect(tool("record_decision_maker").trace).toBe("write_quote_field");
  });

  it("has a handler wired for every tool but the carrier appetite read, and a not_yet_built tool is not runnable", () => {
    expect(FLOW_TOOL_CATALOG.tools.filter((t) => !isRunnable(t)).map((t) => t.name)).toEqual(["check_carrier_appetite"]);
    expect(isRunnable({ ...tool("check_quote_status"), status: "not_yet_built" })).toBe(false);
    expect(isRunnable(tool("email_document"))).toBe(true);
  });

  it("counts the tools per credential and per status", () => {
    expect(flowToolCounts()).toEqual({
      byCredential: { service_role_key: 12, seat_session: 12, admin_machine_credential: 1 },
      byStatus: {
        runs_in_harness_memory: 3,
        queued_after_call: 3,
        reads_development_project: 4,
        needs_seat_session: 2,
        needs_admin_machine_credential: 1,
        not_yet_built: 1,
        runs_in_console: 6,
        calls_crm_app: 5,
      },
    });
  });

  it("lists the quote prototype tools the console bot calls itself, each marked real or simulated", () => {
    const consoleTools = FLOW_TOOL_CATALOG.tools.filter((t) => t.status === "runs_in_console");
    expect(Object.fromEntries(consoleTools.map((t) => [t.name, t.implementation]))).toEqual({
      save_quote_field: "simulated",
      start_quote: "simulated",
      send_quote_link: "simulated",
      check_producer_available: "simulated",
      transfer_to_producer: "simulated",
      take_message: "simulated",
    });
    expect(tool("save_quote_field").parameters.properties.field!.enum).toEqual([
      "full_time_employees", "part_time_employees", "full_time_payroll", "part_time_payroll", "expected_revenue",
    ]);
    for (const t of consoleTools) {
      expect(t.area, t.name).toBe("quote_prototype");
      expect(t.judgeAction, t.name).toBeNull();
      expect(isDispatched(t), t.name).toBe(false);
    }
  });

  it("acts during the call in harness memory only for transfer, texting and hanging up", () => {
    const inCall = FLOW_TOOL_CATALOG.tools.filter((t) => t.status === "runs_in_harness_memory").map((t) => t.name);
    expect(inCall.sort()).toEqual(["end_call", "send_text", "transfer_to_human"]);
  });

  it("acts during the call through CRM's own app only for the writes Dana named (2026-10-21)", () => {
    const app = FLOW_TOOL_CATALOG.tools.filter((t) => t.status === "calls_crm_app").map((t) => t.name);
    expect(app.sort()).toEqual(["add_callback_number", "book_producer", "email_document", "request_quote", "save_contact_detail"]);
  });

  it("offers no tool that records a stop or a channel opt-out", () => {
    for (const t of FLOW_TOOL_CATALOG.tools) {
      expect(`${t.name} ${t.trace}`).not.toMatch(/stop|opt_out|unsubscribe/);
      for (const rule of Object.values(t.parameters.properties)) expect(rule.enum ?? []).not.toContain("opt_out");
    }
  });

  it("throws one error listing every problem", () => {
    const raw = rawCatalog();
    raw.tools[0]!.name = "Bad";
    raw.tools[1]!.status = "someday";
    expect(() => loadFlowToolCatalog(raw)).toThrow(/name must match[\s\S]*unknown status/);
  });
});

describe("catalogProblems catches each rule", () => {
  const cases: Array<[string, (raw: ReturnType<typeof rawCatalog>) => void, RegExp]> = [
    ["a bad name", (raw) => (entry(raw, "save_message").name = "Save-Message"), /name must match/],
    ["a duplicate name", (raw) => (entry(raw, "save_message").name = "write_quote_field"), /duplicate name/],
    ["a decide_ prefix", (raw) => (entry(raw, "save_message").name = "decide_message"), /clashes with the flow compiler/],
    ["the name interrupt", (raw) => (entry(raw, "save_message").name = "interrupt"), /clashes with the flow compiler/],
    ["a reserved trace", (raw) => (entry(raw, "end_call").trace = "end_call"), /trace "end_call" is reserved/],
    ["hard_to_undo without a judge action", (raw) => (entry(raw, "book_producer").judgeAction = null), /hard_to_undo tool needs a judge action/],
    ["an identifier parameter", (raw) => (entry(raw, "save_message").parameters.properties.lead_id = { type: "string" }), /"lead_id" is an identifier/],
    ["a write tool without evidence_quote", (raw) => delete entry(raw, "book_producer").parameters.properties.evidence_quote, /needs evidence_quote/],
    ["send_text templates out of step", (raw) => (raw.templates.extra = "Thanks for your time today."), /template enum must equal/],
    ["an unknown status", (raw) => (entry(raw, "save_message").status = "someday"), /unknown status/],
    ["an unknown legacy status", (raw) => (entry(raw, "start_quote").status = "legacy_blocked"), /unknown status/],
    ["a missing credential", (raw) => delete entry(raw, "save_message").credential, /unknown credential/],
    ["queued_after_call without the service role key", (raw) => (entry(raw, "save_message").credential = "seat_session"), /queued_after_call requires credential service_role_key/],
    ["reads_development_project without the service role key", (raw) => (entry(raw, "read_lead_context").credential = "admin_machine_credential"), /reads_development_project requires credential service_role_key/],
    ["needs_seat_session without a seat session", (raw) => (entry(raw, "cancel_appointment").credential = "service_role_key"), /needs_seat_session requires credential seat_session/],
    ["calls_crm_app without a seat session", (raw) => (entry(raw, "email_document").credential = "service_role_key"), /calls_crm_app requires credential seat_session/],
    ["needs_admin_machine_credential without it", (raw) => (entry(raw, "book_callback").credential = "seat_session"), /needs_admin_machine_credential requires credential admin_machine_credential/],
    ["a write that reads the development project", (raw) => (entry(raw, "save_message").status = "reads_development_project"), /requires risk read_only/],
    ["a read queued after the call", (raw) => (entry(raw, "check_quote_status").status = "queued_after_call"), /queued_after_call requires a write risk/],
    ["another tool running in harness memory", (raw) => (entry(raw, "save_message").status = "runs_in_harness_memory"), /only book_producer, transfer_to_human, send_text, end_call run in harness memory/],
  ];
  it.each(cases)("%s", (_label, change, problem) => {
    const problems = problemsAfter(change);
    expect(problems.some((p) => problem.test(p))).toBe(true);
  });

  it("survives a catalog that is not shaped like one", () => {
    expect(catalogProblems(null)).toEqual(["the catalog is not an object"]);
    expect(catalogProblems({ version: 1, templates: {}, tools: [null] })).toEqual(["tools[0] is not an object"]);
  });
});

describe("hard_to_undo tools and the live judge", () => {
  const hardToUndo = FLOW_TOOL_CATALOG.tools.filter((t) => t.risk === "hard_to_undo" && t.status !== "runs_in_console");

  it("every hard_to_undo tool's judge action is known and counted as hard to undo, with no gap left", () => {
    const notInJudgeActions: string[] = [];
    const notHardToUndo: string[] = [];
    for (const t of hardToUndo) {
      const action = t.judgeAction!;
      if (!isJudgeAction(action)) {
        notInJudgeActions.push(action);
        continue;
      }
      const payload: JudgePayload = action === "end_with_disposition" ? { durable: true } : {};
      if (!isHardToUndo(action, payload)) notHardToUndo.push(action);
    }
    expect({ notInJudgeActions: notInJudgeActions.sort(), notHardToUndo: notHardToUndo.sort() }).toEqual({
      notInJudgeActions: WAITING_ON_STEP_2.notInJudgeActions,
      notHardToUndo: WAITING_ON_STEP_2.notHardToUndo,
    });
  });

  it.each([...JUDGE_ACTIONS])("the rule judge gives %s a real verdict", async (action) => {
    const verdict = await new RuleBasedJudge().judge({
      action,
      nodeId: "test_node",
      direction: "outbound",
      transcript: [
        { role: "agent", text: "Hi, I am an AI assistant calling for the agency.", turnIndex: 0 },
        { role: "caller", text: "Yes, go ahead.", turnIndex: 1 },
      ],
      completed: [],
      payload: {},
      now: new Date("2026-10-15T14:00:00.000Z"),
    });
    expect(typeof verdict.allowed).toBe("boolean");
    expect(Array.isArray(verdict.scores)).toBe(true);
    expect(verdict.scores.length).toBeGreaterThan(0);
  });
});

describe("trace names and the after-call judge", () => {
  /** Score 0 on judge_gate_respected means the trace maps to a judged action, since no verdict came first. */
  async function traceIsJudged(trace: string): Promise<boolean> {
    const at = "2026-10-15T14:00:00.000Z";
    const event: TraceEvent = {
      seq: 1,
      recordSeq: 1,
      at,
      atMs: 0,
      type: "tool_call",
      leadId: "lead-1",
      recordId: "record-1",
      channel: "call",
      data: { tool: trace, success: true },
    };
    const record: HarnessRecord = { recordId: "record-1", kind: "call", leadId: "lead-1", openedAt: at, events: [event], transcript: [], texts: [] };
    const score = await new RuleBasedPostCallJudge().judge(record);
    const gate = score.criteria.find((c) => c.criterion === "judge_gate_respected");
    if (!gate) throw new Error("judge_gate_respected is missing");
    return gate.score === 0;
  }

  it("every gated trace is judged, with no gap left", async () => {
    const gated = [...new Set(FLOW_TOOL_CATALOG.tools.filter((t) => t.judgeAction !== null).map((t) => t.trace))];
    const missing: string[] = [];
    for (const trace of gated) if (!(await traceIsJudged(trace))) missing.push(trace);
    expect(missing.sort()).toEqual(WAITING_ON_STEP_2.traceNotJudged);
  });

  it("no read-only trace is judged", async () => {
    const readOnly = FLOW_TOOL_CATALOG.tools.filter((t) => t.risk === "read_only");
    expect(readOnly.length).toBeGreaterThan(0);
    for (const t of readOnly) expect(await traceIsJudged(t.trace)).toBe(false);
  });
});

describe("validateToolArguments", () => {
  const writeQuoteField = () => tool("write_quote_field");
  const good = { field: "payroll", value: "280,000", evidence_quote: "payroll is about 280,000" };

  it("accepts a good write_quote_field call", () => {
    expect(validateToolArguments(writeQuoteField(), good)).toEqual([]);
  });

  it("refuses a missing required key", () => {
    const { evidence_quote: _dropped, ...rest } = good;
    expect(validateToolArguments(writeQuoteField(), rest)).toEqual(['"evidence_quote" is missing']);
  });

  it("refuses an unknown key", () => {
    expect(validateToolArguments(writeQuoteField(), { ...good, note: "x" })).toEqual(['"note" is not a parameter']);
  });

  it("refuses a value outside the enum", () => {
    expect(validateToolArguments(writeQuoteField(), { ...good, field: "price" })).toEqual(['"field" is not one of the allowed values']);
  });

  it("refuses a string that is too long", () => {
    expect(validateToolArguments(writeQuoteField(), { ...good, value: "9".repeat(201) })).toEqual(['"value" is longer than 200 characters']);
  });

  it("refuses a key ending in _id", () => {
    expect(validateToolArguments(writeQuoteField(), { ...good, lead_id: "lead-1" })).toEqual([
      '"lead_id" is an identifier, which the model never supplies',
    ]);
  });

  it("refuses a value that is not a string and one that misses the pattern", () => {
    expect(validateToolArguments(writeQuoteField(), { ...good, value: 280000 })).toEqual(['"value" must be a string']);
    expect(validateToolArguments(tool("add_callback_number"), { phone: "call me", evidence_quote: "x" })).toEqual([
      '"phone" does not match the expected pattern',
    ]);
  });
});
