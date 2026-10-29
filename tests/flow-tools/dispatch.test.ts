import { beforeEach, describe, expect, it, vi } from "vitest";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { resetHarnessConfig } from "../../src/config.js";
import { storeActionPort, type ActionPort } from "../../src/decision/actions.js";
import { FLOW_TOOL_CATALOG, isDispatched, isRunnable, type FlowTool, type FlowToolCatalog } from "../../src/flow-tools/catalog.js";
import { createFlowDispatcher, type FlowDispatcherDeps } from "../../src/flow-tools/dispatch.js";
import { createCrmStub } from "../../src/flow-tools/crm-stub.js";
import { findQuoteInCallerWords } from "../../src/flow-tools/quotes.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { Judge, JudgeRequest, JudgeVerdict } from "../../src/judge/types.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { mockLeadStore, type LeadStore } from "../../src/store/lead-store-seam.js";
import { ALREADY_BOOKED, toolBookProducer } from "../../src/tools/agent-tools.js";
import { newCallContext, runWithTrace, traceBus, type TraceEvent } from "../../src/trace/events.js";
import { baseLead } from "../helpers/fixtures.js";

const NOW = "2026-10-15T14:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const LEAD = "lead-1";
const CALL = "call_flow_1";
const AGENCY_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_ID = "00000000-0000-4000-8000-0000000000b1";

class FakeReadDb {
  private readonly rows = new Map<string, Array<Record<string, unknown>>>();
  seed(table: string, row: Record<string, unknown>) {
    this.rows.set(table, [...(this.rows.get(table) ?? []), row]);
    return this;
  }
  async select(table: string, query: {
    columns: string;
    eq?: Record<string, string>;
    gte?: Record<string, string>;
    order?: { column: string; ascending: boolean };
    limit?: number;
  }) {
    const rows = (this.rows.get(table) ?? []).filter((row) =>
      Object.entries(query.eq ?? {}).every(([key, value]) => String(row[key]) === value),
    );
    return query.limit ? rows.slice(0, query.limit) : rows;
  }
}

const seededReadDb = () => new FakeReadDb()
  .seed("crm_lead", { id: LEAD_ID, agency_id: AGENCY_ID, entity_id: "00000000-0000-4000-8000-0000000000c1" })
  .seed("crm_producer_presence", { agency_id: AGENCY_ID, producer_id: "00000000-0000-4000-8000-0000000000a2", voice_ready_at: "2026-10-15T13:59:30.000Z", voice_busy_at: null })
  .seed("crm_quote_job", { agency_id: AGENCY_ID, entity_id: "00000000-0000-4000-8000-0000000000c1", status: "rated", mode: "live", created_at: "2026-10-14T00:00:00.000Z" });

/** Valid arguments and the lines that make the code rules pass, for every write tool. */
const FIXTURES: Record<string, { args: Record<string, string>; lines: Array<["caller" | "agent", string]> }> = {
  write_quote_field: { args: { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" }, lines: [["caller", "Our renewal is in March 2027."]] },
  save_contact_detail: { args: { field: "email", value: "pat@example.com", evidence_quote: "my email is pat at example dot com" }, lines: [["caller", "My email is pat at example dot com."]] },
  add_callback_number: { args: { phone: "+1 555 010 0199", label: "mobile", evidence_quote: "reach me at +1 555 010 0199" }, lines: [["caller", "You can reach me at +1 555 010 0199 on my mobile."]] },
  record_decision_maker: {
    args: { name: "Chris Morgan", role: "partner", phone: "+1 555 010 0123", evidence_quote: "my partner Chris Morgan decides, their number is +1 555 010 0123" },
    lines: [["caller", "My partner Chris Morgan decides, their number is +1 555 010 0123."]],
  },
  save_message: { args: { kind: "message", body: "I need the certificate by Friday", evidence_quote: "I need the certificate by Friday" }, lines: [["caller", "Tell the producer I need the certificate by Friday."]] },
  start_quote: { args: { line: "workers_compensation", evidence_quote: "I would like a quote" }, lines: [["caller", "I would like a quote for my crew."]] },
  book_producer: {
    args: { slot_iso: "2026-10-16T19:00:00.000Z", slot_words: "Friday at 3 PM", evidence_quote: "Friday at 3 PM works for me" },
    lines: [["caller", "Friday at 3 PM works for me."], ["agent", "So that is Friday at 3 PM. Shall I book it?"], ["caller", "Yes, please."]],
  },
  book_callback: {
    args: { at: "2026-10-16T19:00:00.000Z", at_words: "Friday at 3 PM", evidence_quote: "call me back Friday at 3 PM" },
    lines: [["caller", "Call me back Friday at 3 PM."], ["agent", "So that is Friday at 3 PM. Is that right?"], ["caller", "Yes, that works."]],
  },
  cancel_appointment: { args: { evidence_quote: "I need to cancel my appointment" }, lines: [["caller", "I need to cancel my appointment with the producer."]] },
  transfer_to_human: { args: { reason: "caller_requested", note_for_producer: "Wants to talk about the renewal.", evidence_quote: "talk to a real person" }, lines: [["caller", "Can I talk to a real person?"]] },
  send_text: { args: { template: "message_received", evidence_quote: "that works" }, lines: [["agent", "Would you like a text saying we have your message?"], ["caller", "Yes, that works."]] },
  email_document: { args: { document: "loss_run_request", evidence_quote: "email me the loss run form" }, lines: [["caller", "Please email me the loss run form."]] },
  end_call: { args: { disposition: "not_interested", evidence_quote: "I am not interested" }, lines: [["caller", "I am not interested, thank you."]] },
  mark_not_eligible: { args: { reason: "out_of_business", evidence_quote: "we closed the business" }, lines: [["caller", "We closed the business last year."]] },
  request_quote: { args: { evidence_quote: "yes start the quote" }, lines: [["agent", "Would you like me to start your quote?"], ["caller", "Yes start the quote please."]] },
};

const callerLines = (tool: string) => FIXTURES[tool]!.lines.filter(([role]) => role === "caller").map(([, text]) => text);

const READ_ARGS: Record<string, Record<string, string>> = { check_appointment_time: { day: "2026-10-16", time: "10:00" }, check_carrier_appetite: { business_class: "roofing" } };

const gatedTools = FLOW_TOOL_CATALOG.tools.filter((t) => t.risk !== "read_only" && t.status !== "runs_in_console");
const readTools = FLOW_TOOL_CATALOG.tools.filter((t) => t.risk === "read_only" && isDispatched(t));
const needsCredential = (t: FlowTool) => t.status === "needs_seat_session" || t.status === "needs_admin_machine_credential";

class RefusingJudge implements Judge {
  readonly id = "refusing-stub";
  readonly calls: JudgeRequest[] = [];
  async judge(request: JudgeRequest): Promise<JudgeVerdict> {
    this.calls.push(request);
    return { allowed: false, reason: "the stub judge refuses everything", scores: [{ criterion: "stub", score: 0, note: "refused" }] };
  }
}

function spyPort(): { [K in keyof ActionPort]: ReturnType<typeof vi.fn> } {
  return { transfer: vi.fn(async () => true), saveQuoteField: vi.fn(async () => true), saveDetails: vi.fn(async () => true), book: vi.fn(async () => true), sendText: vi.fn(async () => true), endWithDisposition: vi.fn(async () => true) };
}

function spyStore() {
  const writes = {
    writeQuoteField: vi.fn(async () => true),
    appendHandoffNote: vi.fn(async () => undefined),
    recordStop: vi.fn(async () => ({ recorded: "mock" as const })),
    saveMessageIdempotent: vi.fn(),
    bookProducerIdempotent: vi.fn(),
    tryClaimIdempotency: vi.fn(async () => true),
    releaseIdempotency: vi.fn(async () => undefined),
  };
  const store = { getLead: vi.fn(async () => baseLead()), ...writes } as unknown as LeadStore;
  return { store, writes };
}

function make(overrides: Partial<FlowDispatcherDeps> & { judge?: Judge } = {}) {
  const { judge = new RuleBasedJudge(), ...rest } = overrides;
  const onStop = vi.fn(async (_text: string) => undefined);
  const deps: FlowDispatcherDeps = {
    leadId: LEAD, callId: CALL, agencyId: AGENCY_ID, direction: "inbound", clock,
    gate: { judge, leadId: LEAD, callId: CALL }, store: mockLeadStore, onStop, ...rest,
  };
  return { dispatcher: createFlowDispatcher(deps), onStop };
}

async function speak(d: ReturnType<typeof make>["dispatcher"], lines: Array<["caller" | "agent", string]>) {
  d.sayAgent(inboundOpeningScript());
  for (const [role, text] of lines) {
    if (role === "agent") d.sayAgent(text);
    else await d.hearCaller(text);
  }
}

/** Runs `fn` inside a call trace and returns the events it emitted. */
async function traced(fn: () => Promise<void>): Promise<TraceEvent[]> {
  const ctx = newCallContext(LEAD, "inbound");
  await runWithTrace(ctx, fn);
  return traceBus.history().filter((e) => e.recordId === ctx.recordId);
}
const verdicts = (events: TraceEvent[]) => events.filter((e) => e.type === "judge_verdict");
const dispositionsTraced = (events: TraceEvent[]) => events.filter((e) => e.type === "disposition").map((e) => e.data.value);

beforeEach(() => {
  resetHarnessConfig();
  resetLeadStore();
  clearCallLogs();
  traceBus.reset();
  seedLead(baseLead({ id: LEAD }));
});

describe("flow tool dispatcher", () => {
  it("has one entry for exactly the catalog tools that are runnable", () => {
    const { dispatcher } = make();
    expect([...dispatcher.entries].sort()).toEqual(FLOW_TOOL_CATALOG.tools.filter(isDispatched).map((t) => t.name).sort());
    const copy: FlowToolCatalog = structuredClone(FLOW_TOOL_CATALOG);
    copy.tools.find((t) => t.name === "check_quote_status")!.status = "not_yet_built";
    expect(make({ catalog: copy }).dispatcher.entries).not.toContain("check_quote_status");
  });

  it("records allowed app actions in the local CRM stub", async () => {
    const crm = createCrmStub();
    const { dispatcher } = make({ crm });
    await speak(dispatcher, FIXTURES.save_contact_detail!.lines);
    expect((await dispatcher.dispatch({ name: "save_contact_detail", arguments: FIXTURES.save_contact_detail!.args })).ok).toBe(true);
    expect(crm.actions).toEqual([
      {
        name: "save_contact_detail",
        arguments: {
          field: "email",
          value: "pat@example.com",
          evidenceQuote: "My email is pat at example dot com",
        },
      },
    ]);
  });

  it("refuses unknown tools, tools not built and bad arguments, and never takes an identifier from the model", async () => {
    const copy: FlowToolCatalog = structuredClone(FLOW_TOOL_CATALOG);
    copy.tools.find((t) => t.name === "check_quote_status")!.status = "not_yet_built";
    const { dispatcher } = make({ catalog: copy });
    expect((await dispatcher.dispatch({ name: "record_stop", arguments: {} })).refused?.code).toBe("unknown_tool");
    expect((await dispatcher.dispatch({ name: "check_quote_status", arguments: {} })).refused?.code).toBe("not_built");
    expect((await dispatcher.dispatch({ name: "save_message", arguments: "not an object" })).refused?.code).toBe("invalid_arguments");
    expect((await dispatcher.dispatch({ name: "read_lead_context", arguments: { lead_id: "other" } })).refused?.code).toBe("invalid_arguments");
  });

  it("never runs a gated tool when the code rules pass and an injected judge refuses", async () => {
    for (const tool of gatedTools) {
      const fixture = FIXTURES[tool.name]!;
      const judge = new RefusingJudge();
      const port = spyPort();
      const { store, writes } = spyStore();
      const { dispatcher } = make({ judge, actions: port as unknown as ActionPort, store });
      await speak(dispatcher, fixture.lines);
      const result = await dispatcher.dispatch({ name: tool.name, arguments: fixture.args });
      expect(result.ok, tool.name).toBe(false);
      expect(result.refused, tool.name).toBeDefined();
      // Proof the code rules passed: the stub was asked, for every tool that reaches the gate.
      expect(judge.calls.length, tool.name).toBe(needsCredential(tool) ? 0 : 1);
      for (const fn of [...Object.values(port), ...Object.values(writes)]) expect(fn, tool.name).not.toHaveBeenCalled();
      expect(dispatcher.state.completed, tool.name).toEqual([]);
      expect(dispatcher.state.filings, tool.name).toEqual([]);
    }
  });

  it("never runs a gated tool on an empty transcript with the local rule judge", async () => {
    for (const tool of gatedTools) {
      const port = spyPort();
      const { store, writes } = spyStore();
      const { dispatcher } = make({ actions: port as unknown as ActionPort, store });
      const result = await dispatcher.dispatch({ name: tool.name, arguments: FIXTURES[tool.name]!.args });
      expect(result.ok, tool.name).toBe(false);
      for (const fn of [...Object.values(port), ...Object.values(writes)]) expect(fn, tool.name).not.toHaveBeenCalled();
    }
  });

  it("refuses a quote that is not inside any caller turn before the judge is asked", async () => {
    const judge = new RefusingJudge();
    const judgeSpy = vi.spyOn(judge, "judge");
    const { dispatcher } = make({ judge });
    const events = await traced(async () => {
      await speak(dispatcher, FIXTURES.write_quote_field!.lines);
      const result = await dispatcher.dispatch({ name: "write_quote_field", arguments: { ...FIXTURES.write_quote_field!.args, evidence_quote: "renewal is in June 2027" } });
      expect(result.refused?.code).toBe("evidence_not_in_caller_words");
    });
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(verdicts(events)).toEqual([]);
    // The same call with the caller's real words does reach the gate, inside the same kind of trace.
    const control = await traced(async () => {
      await dispatcher.dispatch({ name: "write_quote_field", arguments: FIXTURES.write_quote_field!.args });
    });
    expect(verdicts(control)).toHaveLength(1);
  });

  it("accepts a quote that differs from the caller's words only in case and punctuation, and passes on the caller's own text", async () => {
    const seen: JudgeRequest[] = [];
    const judge: Judge = { id: "allowing-stub", judge: async (request) => (seen.push(request), { allowed: true, reason: "allowed", scores: [] }) };
    const { dispatcher } = make({ judge });
    await speak(dispatcher, [["caller", "Our renewal, I think, is in March 2027."]]);
    const result = await dispatcher.dispatch({ name: "write_quote_field", arguments: { field: "x_date", value: "March 2027", evidence_quote: "our renewal i think is in MARCH 2027" } });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.evidenceSpan).toBe("Our renewal, I think, is in March 2027");
    expect(dispatcher.state.filings.at(-1)?.arguments.evidence_quote).toBe("Our renewal, I think, is in March 2027");
    // The words must still come in the caller's order.
    const reordered = await dispatcher.dispatch({ name: "write_quote_field", arguments: { field: "x_date", value: "March 2027", evidence_quote: "in March 2027 is our renewal" } });
    expect(reordered.refused?.code).toBe("evidence_not_in_caller_words");
    expect(seen).toHaveLength(1);
  });

  it("runs read-only tools without ever calling the judge", async () => {
    const judge = new RefusingJudge();
    const judgeSpy = vi.spyOn(judge, "judge");
    const db = seededReadDb();
    const { dispatcher } = make({ judge, db, leadId: LEAD });
    const results: string[] = [];
    const events = await traced(async () => {
      await speak(dispatcher, [["caller", "Hi, I am calling about my quote."]]);
      for (const tool of readTools) {
        const result = await dispatcher.dispatch({ name: tool.name, arguments: READ_ARGS[tool.name] ?? {} });
        results.push(result.speakable);
      }
    });
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(verdicts(events)).toEqual([]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.data.tool).sort()).toEqual(readTools.map((t) => t.trace).sort());
    // Short sentences, never a figure the caller could hear as a price.
    for (const text of results) expect(text).not.toMatch(/\$|\d/);
  });

  it("answers the service role reads from the development project, and refuses them with no database client", async () => {
    const db = seededReadDb();
    const connected = make({ db, leadId: LEAD_ID }).dispatcher;
    expect((await connected.dispatch({ name: "list_available_producers", arguments: {} })).speakable).toMatch(/is free to take a transfer/);
    expect((await connected.dispatch({ name: "check_quote_status", arguments: {} })).speakable).toMatch(/quote is ready/);
    // No handler is wired to the optional carrier appetite integration, so a connected client changes nothing.
    expect((await connected.dispatch({ name: "check_carrier_appetite", arguments: READ_ARGS.check_carrier_appetite })).refused?.code).toBe("not_built");
    const offline = make().dispatcher;
    for (const name of ["list_available_producers", "check_quote_status"]) {
      expect((await offline.dispatch({ name, arguments: READ_ARGS[name] ?? {} })).refused?.code, name).toBe("not_connected");
    }
  });

  it("records a heard stop once, through the stop path, when the model never calls end_call", async () => {
    const { dispatcher, onStop } = make();
    const events = await traced(async () => {
      await speak(dispatcher, [["caller", "Please stop calling me."], ["caller", "Do not call this number."]]);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("Please stop calling me.");
    expect(dispositionsTraced(events)).toEqual(["do_not_contact"]);
    expect(dispatcher.state).toMatchObject({ stopped: true, disposition: "do_not_contact" });
    expect((await dispatcher.dispatch({ name: "read_lead_context", arguments: {} })).refused?.code).toBe("call_stopped");
  });

  it("keeps a heard stop when end_call is then called with a refusing judge", async () => {
    const judge = new RefusingJudge();
    const port = spyPort();
    const { dispatcher, onStop } = make({ judge, actions: port as unknown as ActionPort });
    const events = await traced(async () => {
      await speak(dispatcher, [["caller", "Take me off your list."]]);
      const result = await dispatcher.dispatch({ name: "end_call", arguments: { disposition: "talked" } });
      expect(result.endCall).toBe(true);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(judge.calls).toEqual([]);
    expect(port.endWithDisposition).not.toHaveBeenCalled();
    expect(dispatcher.state.disposition).toBe("do_not_contact");
    expect(dispositionsTraced(events)).toEqual(["do_not_contact"]);
  });

  it("never records a stop from end_call(do_not_contact) when no stop phrase was heard", async () => {
    const { store, writes } = spyStore();
    const { dispatcher, onStop } = make({ store });
    const events = await traced(async () => {
      await speak(dispatcher, [["caller", "I think we are done here."]]);
      const result = await dispatcher.dispatch({ name: "end_call", arguments: { disposition: "do_not_contact", evidence_quote: "we are done here" } });
      expect(result).toMatchObject({ ok: false, endCall: true, refused: { code: "stop_not_heard" } });
    });
    expect(onStop).not.toHaveBeenCalled();
    expect(writes.recordStop).not.toHaveBeenCalled();
    expect(dispatcher.state).toMatchObject({ stopped: false, disposition: "talked" });
    expect(dispositionsTraced(events)).toEqual(["talked"]);
  });

  it("still hangs up and ends as talked when the judge refuses a durable disposition", async () => {
    const judge = new RefusingJudge();
    const { dispatcher } = make({ judge, actions: storeActionPort({ store: mockLeadStore, leadId: LEAD, callId: CALL, sendText: async () => ({ status: "not_sent" }) }) });
    const events = await traced(async () => {
      await speak(dispatcher, FIXTURES.end_call!.lines);
      const result = await dispatcher.dispatch({ name: "end_call", arguments: FIXTURES.end_call!.args });
      expect(result).toMatchObject({ ok: false, endCall: true, refused: { code: "judge_refused" } });
    });
    expect(judge.calls).toHaveLength(1);
    expect(dispatcher.state.disposition).toBe("talked");
    expect(dispositionsTraced(events)).toEqual(["talked"]);
    expect(events.some((e) => e.type === "tool_call" && e.data.tool === "record_disposition")).toBe(false);
    expect(dispatcher.state.notes.join(" ")).toMatch(/not_interested was refused/);
    expect(dispatcher.state.notes.join(" ")).not.toContain("I am not interested");
  });

  it("never calls the judge or a run function for a tool that needs a credential, and records a follow-up", async () => {
    const tools = FLOW_TOOL_CATALOG.tools.filter(needsCredential);
    expect(tools.map((t) => t.status).sort()).toContain("needs_admin_machine_credential");
    expect(tools.map((t) => t.status)).toContain("needs_seat_session");
    for (const tool of tools) {
      const judge = new RefusingJudge();
      const port = spyPort();
      const { store, writes } = spyStore();
      const { dispatcher } = make({ judge, actions: port as unknown as ActionPort, store });
      await speak(dispatcher, FIXTURES[tool.name]!.lines);
      const result = await dispatcher.dispatch({ name: tool.name, arguments: FIXTURES[tool.name]!.args });
      expect(result.refused?.code, tool.name).toBe("needs_credential");
      expect(result.speakable, tool.name).toMatch(/licensed producer will follow up/);
      expect(judge.calls, tool.name).toEqual([]);
      for (const fn of [...Object.values(port), ...Object.values(writes)]) expect(fn, tool.name).not.toHaveBeenCalled();
      expect(dispatcher.state.followUps, tool.name).toEqual([
        { tool: tool.name, credential: tool.credential, arguments: expect.not.objectContaining({ evidence_quote: expect.anything() }), at: NOW },
      ]);
    }
  });

  it("files exactly one after-call filing for each allowed queued tool", async () => {
    const queued = FLOW_TOOL_CATALOG.tools.filter((t) => t.status === "queued_after_call");
    expect(queued.length).toBeGreaterThan(0);
    for (const tool of queued) {
      const { dispatcher } = make({ leadId: LEAD_ID, gate: { judge: new RuleBasedJudge(), leadId: LEAD_ID, callId: CALL } });
      await speak(dispatcher, FIXTURES[tool.name]!.lines);
      const result = await dispatcher.dispatch({ name: tool.name, arguments: FIXTURES[tool.name]!.args });
      expect(result.ok, `${tool.name}: ${result.refused?.reason}`).toBe(true);
      expect(dispatcher.state.filings, tool.name).toEqual([
        {
          tool: tool.name, crmCall: tool.crmTarget, credential: "service_role_key", callId: CALL, leadId: LEAD_ID, at: NOW,
          // The filing carries the caller's own text for the quote, not the model's wording of it.
          arguments: { ...FIXTURES[tool.name]!.args, evidence_quote: findQuoteInCallerWords(callerLines(tool.name), FIXTURES[tool.name]!.args.evidence_quote!) },
        },
      ]);
    }
  });

  it("keeps the kind of a saved message in harness memory", async () => {
    const { dispatcher } = make();
    await speak(dispatcher, FIXTURES.save_message!.lines);
    expect((await dispatcher.dispatch({ name: "save_message", arguments: FIXTURES.save_message!.args })).ok).toBe(true);
    expect(getLead(LEAD)!.messages).toEqual([expect.objectContaining({ kind: "message", body: "I need the certificate by Friday" })]);
  });

  it("refuses a contact value that is not inside the caller's quote, before the reach check and the judge", async () => {
    const reach = vi.fn(async () => ({ allowed: true, reason: "allowed" }));
    const judge = new RefusingJudge();
    const port = spyPort();
    const { dispatcher } = make({ judge, actions: port as unknown as ActionPort, store: { ...mockLeadStore, finalReachCheck: reach } });
    await speak(dispatcher, FIXTURES.add_callback_number!.lines);
    const phone = await dispatcher.dispatch({ name: "add_callback_number", arguments: { ...FIXTURES.add_callback_number!.args, phone: "+1 555 010 0100" } });
    expect(phone.refused?.code).toBe("value_not_in_quote");
    await speak(dispatcher, FIXTURES.save_contact_detail!.lines);
    const email = await dispatcher.dispatch({ name: "save_contact_detail", arguments: { ...FIXTURES.save_contact_detail!.args, value: "sam@example.com" } });
    expect(email.refused?.code).toBe("value_not_in_quote");
    expect(reach).not.toHaveBeenCalled();
    expect(judge.calls).toEqual([]);
    expect(port.saveDetails).not.toHaveBeenCalled();
    expect(dispatcher.state.filings).toEqual([]);
    // The number the caller did say, and the email as spoken, do reach the judge.
    await dispatcher.dispatch({ name: "add_callback_number", arguments: FIXTURES.add_callback_number!.args });
    await dispatcher.dispatch({ name: "save_contact_detail", arguments: FIXTURES.save_contact_detail!.args });
    expect(judge.calls).toHaveLength(2);
  });

  it("refuses the callback confirmation text while no callback was booked in the call", async () => {
    const judge = new RefusingJudge();
    const port = spyPort();
    const { dispatcher } = make({ judge, actions: port as unknown as ActionPort });
    await speak(dispatcher, FIXTURES.book_callback!.lines);
    expect((await dispatcher.dispatch({ name: "book_callback", arguments: FIXTURES.book_callback!.args })).refused?.code).toBe("needs_credential");
    await speak(dispatcher, FIXTURES.send_text!.lines);
    const result = await dispatcher.dispatch({ name: "send_text", arguments: { ...FIXTURES.send_text!.args, template: "callback_time_confirmed" } });
    expect(result.refused?.code).toBe("template_not_backed");
    expect(judge.calls).toEqual([]);
    expect(port.sendText).not.toHaveBeenCalled();
  });

  it("refuses the appointment confirmation text with no booking, and after a booking that did not happen", async () => {
    const appointmentText = { ...FIXTURES.send_text!.args, template: "appointment_confirmed" };
    const judge = new RefusingJudge();
    const none = make({ judge }).dispatcher;
    await speak(none, FIXTURES.send_text!.lines);
    expect((await none.dispatch({ name: "send_text", arguments: appointmentText })).refused?.code).toBe("template_not_backed");
    expect(judge.calls).toEqual([]);

    seedLead(baseLead({ id: LEAD, bookings: [{ id: "b0", leadId: LEAD, callId: CALL, slotIso: "2026-10-17T15:00:00.000Z", createdAt: NOW }] }));
    const already = make().dispatcher;
    await speak(already, FIXTURES.book_producer!.lines);
    expect((await already.dispatch({ name: "book_producer", arguments: FIXTURES.book_producer!.args })).speakable).toBe(ALREADY_BOOKED);
    await speak(already, FIXTURES.send_text!.lines);
    expect((await already.dispatch({ name: "send_text", arguments: appointmentText })).refused?.code).toBe("template_not_backed");
  });

  it("lets the appointment confirmation text reach the judge after a real booking", async () => {
    const rules = new RuleBasedJudge();
    const asked: string[] = [];
    const judge: Judge = { id: "recording", judge: (request) => (asked.push(request.action), rules.judge(request)) };
    const { dispatcher } = make({ judge });
    await speak(dispatcher, FIXTURES.book_producer!.lines);
    expect((await dispatcher.dispatch({ name: "book_producer", arguments: FIXTURES.book_producer!.args })).ok).toBe(true);
    await speak(dispatcher, FIXTURES.send_text!.lines);
    const result = await dispatcher.dispatch({ name: "send_text", arguments: { ...FIXTURES.send_text!.args, template: "appointment_confirmed" } });
    expect(result.refused?.code).not.toBe("template_not_backed");
    expect(asked).toEqual(["book", "send_text"]);
  });

  it("says truthfully that the call already has a booking at another time", async () => {
    seedLead(baseLead({ id: LEAD, bookings: [{ id: "b0", leadId: LEAD, callId: CALL, slotIso: "2026-10-17T15:00:00.000Z", createdAt: NOW }] }));
    const { dispatcher } = make();
    await speak(dispatcher, FIXTURES.book_producer!.lines);
    const result = await dispatcher.dispatch({ name: "book_producer", arguments: FIXTURES.book_producer!.args });
    expect(result).toMatchObject({ ok: false, speakable: ALREADY_BOOKED });
    expect(dispatcher.state.completed).not.toContain("book");
    expect(await toolBookProducer(mockLeadStore, LEAD, CALL, "2026-10-17T15:00:00+00:00")).toMatchObject({ booked: true });
    expect(getLead(LEAD)!.bookings).toHaveLength(1);
  });

  it("refuses a booking time outside five minutes to sixty days before the judge", async () => {
    const judge = new RefusingJudge();
    const { dispatcher } = make({ judge });
    await speak(dispatcher, FIXTURES.book_producer!.lines);
    for (const slot of ["2026-10-15T14:01:00.000Z", "2026-12-20T14:00:00.000Z", "not a time"]) {
      const result = await dispatcher.dispatch({ name: "book_producer", arguments: { ...FIXTURES.book_producer!.args, slot_iso: slot } });
      expect(result.refused?.code, slot).toBe("slot_out_of_range");
    }
    expect(judge.calls).toEqual([]);
  });

  it("refuses a tool whose judge action the judge does not know yet, rather than standing in another", async () => {
    const copy: FlowToolCatalog = structuredClone(FLOW_TOOL_CATALOG);
    // Every catalog judge action is known since build step 2, so the copy names one the judge has never heard of.
    Object.assign(copy.tools.find((t) => t.name === "cancel_appointment")!, { status: "queued_after_call", credential: "service_role_key", judgeAction: "not_a_judge_action" });
    const judge = new RefusingJudge();
    const port = spyPort();
    const { dispatcher } = make({ catalog: copy, judge, actions: port as unknown as ActionPort });
    await speak(dispatcher, FIXTURES.cancel_appointment!.lines);
    const result = await dispatcher.dispatch({ name: "cancel_appointment", arguments: FIXTURES.cancel_appointment!.args });
    expect(result.refused?.code).toBe("judge_action_missing");
    expect(judge.calls).toEqual([]);
    for (const fn of Object.values(port)) expect(fn).not.toHaveBeenCalled();
  });

  it("checks a new callback number as itself, and saves nothing when it cannot be reached", async () => {
    const reach = vi.fn(async () => ({ allowed: false, reason: "blocked" }));
    const judge = new RefusingJudge();
    const port = spyPort();
    const { dispatcher } = make({ judge, actions: port as unknown as ActionPort, store: { ...mockLeadStore, finalReachCheck: reach } });
    await speak(dispatcher, FIXTURES.add_callback_number!.lines);
    const result = await dispatcher.dispatch({ name: "add_callback_number", arguments: FIXTURES.add_callback_number!.args });
    expect(reach).toHaveBeenCalledWith(LEAD, "call", "+1 555 010 0199");
    expect(result).toMatchObject({ ok: false, refused: { code: "number_not_reachable" } });
    expect(result.speakable).toMatch(/producer will confirm that number/);
    expect(judge.calls).toEqual([]);
    expect(port.saveDetails).not.toHaveBeenCalled();
    expect(dispatcher.state.filings).toEqual([]);
  });
});
