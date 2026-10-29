import { describe, expect, it } from "vitest";
import { headcountIn, payrollIn } from "../../src/flow-tools/dispatch.js";

describe("request_quote's workforce from the saved values", () => {
  it("adds the full-time and part-time head count, never the field figure", () => {
    expect(headcountIn("3 full-time, 1 part-time")).toBe(4);
    expect(headcountIn("2 full-time, 0 part-time, 2 in the field")).toBe(2);
    expect(headcountIn("2 full-time, no part-time, 2 in the field")).toBe(2);
    expect(headcountIn("five full-time and two part-time")).toBe(7);
    expect(headcountIn("9")).toBe(9);
    expect(headcountIn("")).toBeUndefined();
  });

  it("adds every payroll figure", () => {
    expect(payrollIn("$250,000 full-time, $40,000 part-time")).toBe(290000);
    expect(payrollIn("about 300k")).toBe(300000);
    expect(payrollIn("three hundred thousand")).toBe(300000);
    expect(payrollIn("")).toBeUndefined();
  });
});
