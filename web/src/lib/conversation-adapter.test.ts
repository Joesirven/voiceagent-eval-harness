import { describe, expect, it } from "vitest";
import { derive, sampleCall } from "../test/trace-fixtures";
import { toConversationMessages } from "./conversation-adapter";

describe("conversation adapter", () => {
  const sorted = sampleCall();
  const { groups, judged } = derive(sorted);
  const messages = toConversationMessages({ sorted, groups, judged, plain: () => undefined });

  it("maps lines to user and assistant messages, each followed by its reasoning rows", () => {
    const roles = messages.map((m) => m.role);
    expect(roles.filter((r) => r !== "function_call")).toEqual(["assistant", "user", "assistant"]);
    // Each reasoning row follows the line it belongs to: the first row after the caller line is a decision.
    const afterCaller = messages[roles.indexOf("user") + 1]!;
    expect(afterCaller.role).toBe("function_call");
    expect(afterCaller.functionCall!.function_name).toBe("decision");
  });

  it("hides the agent context tool call", () => {
    const calls = messages.filter((m) => m.role === "function_call").map((m) => m.functionCall!);
    expect(calls.some((c) => (c.args as any).tool === "agent_context")).toBe(false);
    expect(calls.some((c) => (c.args as any).tool === "voice_session_open")).toBe(true);
    // The fixture does contain the agent context row, so the filter is what removes it.
    expect(sorted.some((e) => e.type === "tool_call" && e.data.tool === "agent_context")).toBe(true);
  });

  it("renders decisions and judge verdicts as completed function calls", () => {
    const calls = messages.filter((m) => m.role === "function_call").map((m) => m.functionCall!);
    const kinds = calls.map((c) => c.function_name);
    expect(kinds).toContain("decision");
    expect(kinds).toContain("judge");
    for (const c of calls) expect(c.status).toBe("completed");
    const verdict = calls.find((c) => (c.result as any).summary.startsWith("allowed speak"));
    expect(verdict).toBeTruthy();
  });

  it("keeps caller words as a plain string", () => {
    const caller = messages.find((m) => m.role === "user")!;
    expect(caller.parts[0]!.text).toBe("<b>I want a quote</b>");
    expect(typeof caller.parts[0]!.text).toBe("string");
  });

  it("carries the plain sentence only when it differs from the label", () => {
    const withPlain = toConversationMessages({ sorted, groups, judged, plain: () => "A sentence." });
    const calls = withPlain.filter((m) => m.role === "function_call").map((m) => m.functionCall!);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const result = c.result as any;
      // A sentence identical to the label is dropped; every other row carries it.
      if (result.summary === "A sentence.") expect(result.plain).toBeUndefined(); else expect(result.plain).toBe("A sentence.");
    }
  });
});
