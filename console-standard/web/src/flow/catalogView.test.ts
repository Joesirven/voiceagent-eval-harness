import { describe, expect, it } from "vitest";
import { EMPTY_CATALOG, normalizeCatalog, statusWords, toolRow, warningsFor } from "./catalogView";

describe("catalog view", () => {
  it("writes statuses as readable words", () => {
    expect(statusWords("needs_seat_session")).toBe("needs a signed-in seat session");
    expect(statusWords("needs_seat_session")).toBe("needs a signed-in seat session");
    expect(statusWords("needs_admin_machine_credential")).toBe("needs the administrator machine credential");
    expect(statusWords("not_yet_built")).toBe("not yet built");
    expect(statusWords("some_new_status")).toBe("some new status");
    expect(statusWords(3)).toBe("unknown");
  });
  it("drops malformed entries and unknown shapes", () => {
    const c = normalizeCatalog({ version: 2, tools: [null, 7, "t", [], { area: "x" }, { name: "ok" }] });
    expect(c).toEqual({ version: 2, tools: [{ name: "ok" }] });
    expect(normalizeCatalog(null)).toBe(EMPTY_CATALOG);
    expect(normalizeCatalog({ tools: "no" })).toBe(EMPTY_CATALOG);
  });
  it("fills defaults in a row and reads only documented fields", () => {
    const row = toolRow({ name: "t", judge_action: "ignored" } as never, {});
    expect(row).toMatchObject({ judgeAction: "not gated", credential: "none", risk: "unknown", usedIn: "not used", status: "unknown" });
    expect(toolRow({ name: "t", judgeAction: "book", risk: "hard_to_undo" }, { t: ["a", "b"] })).toMatchObject({ judgeAction: "book", riskTone: "danger", usedIn: "a, b" });
  });
  it("warns only for used tools with a warning status", () => {
    const catalog = { version: 1, tools: [
      { name: "a", status: "not_yet_built" }, { name: "b", status: "needs_seat_session" }, { name: "c", status: "needs_admin_machine_credential" },
      { name: "d", status: "runs_in_harness_memory" }, { name: "e", status: "needs_seat_session" },
    ] };
    const warnings = warningsFor(catalog, { a: ["n1"], b: ["n2"], c: ["n3"], d: ["n4"], e: [] });
    expect(warnings.map((w) => w.name)).toEqual(["a", "b", "c"]);
  });
});
