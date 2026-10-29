import { describe, expect, it } from "vitest";
import { orbState } from "./orb-state";

const at = (ms: number) => new Date(ms).toISOString();
const ev = (type: string, ms: number, data: Record<string, unknown> = {}) => ({ type, at: at(ms), data }) as any;

describe("orb state", () => {
  it("is idle outside a call", () => {
    expect(orbState([ev("transcript_final", 0, { role: "agent" })], false, 100)).toBeNull();
  });
  it("is listening at the start of a call and while the caller talks", () => {
    expect(orbState([], true, 0)).toBe("listening");
    expect(orbState([ev("transcript_partial", 0, { role: "caller" })], true, 100)).toBe("listening");
  });
  it("is talking while the agent's words are fresh, then listening again", () => {
    const events = [ev("transcript_partial", 1000, { role: "agent" })];
    expect(orbState(events, true, 1500)).toBe("talking");
    expect(orbState(events, true, 9000)).toBe("listening");
  });
  it("is thinking right after a decision or judge row", () => {
    const events = [ev("transcript_final", 0, { role: "caller" }), ev("decision", 1000)];
    expect(orbState(events, true, 2000)).toBe("thinking");
    expect(orbState(events, true, 20000)).toBe("listening");
  });
});
