import { describe, expect, it } from "vitest";
import { batchFrom, emitBatch } from "../../src/server/pipecat-trace-route.js";

describe("the page's Pipecat rows onto the trace bus", () => {
  const good = { callId: "pipecat_testcall", leadId: "00000000-0000-4000-8000-0000000000b1", leadLabel: "Maria", direction: "inbound", rows: [
    { type: "transcript_final", data: { role: "caller", text: "Yes, this is me.", turnIndex: 0 } },
    { type: "node_enter", data: { nodeId: "frame_call", label: "frame call" }, flowStep: "recognize_lead" },
    { type: "call_outcome", data: { status: "ai_handled", reason: "session ended" } },
  ] };

  it("takes a Pipecat call id, the page's row types and a bounded batch, in order", () => {
    const batch = batchFrom(good);
    expect(batch.rows).toHaveLength(3);
    const seen: Array<Record<string, unknown>> = [];
    let seq = 0;
    const seqs = emitBatch(batch, (input) => { seen.push(input as unknown as Record<string, unknown>); return { seq: ++seq }; });
    expect(seqs).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ type: "transcript_final", callId: "pipecat_testcall", recordId: "pipecat_testcall", leadId: good.leadId, leadLabel: "Maria", channel: "call", direction: "inbound" });
    expect(seen[1]).toMatchObject({ type: "node_enter", flowStep: "recognize_lead" });
    expect(seen[2]).toMatchObject({ type: "call_outcome" });
  });

  it("refuses a harness call id, an unknown row type, a row without data, and an empty or oversized batch", () => {
    expect(() => batchFrom({ ...good, callId: "call_bad_identifier" })).toThrow("bad_call_id");
    expect(() => batchFrom({ ...good, rows: [{ type: "judge_score", data: {} }] })).toThrow("bad_row_type");
    expect(() => batchFrom({ ...good, rows: [{ type: "tool_call" }] })).toThrow("bad_row_data");
    expect(() => batchFrom({ ...good, rows: [] })).toThrow("bad_rows");
    expect(() => batchFrom({ ...good, rows: Array.from({ length: 101 }, () => good.rows[0]) })).toThrow("bad_rows");
    expect(() => batchFrom({ ...good, leadId: "not ok/../x" })).toThrow("bad_lead_id");
  });
});
