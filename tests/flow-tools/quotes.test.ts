import { describe, expect, it } from "vitest";
import { findQuoteInCallerWords, normalizeQuote, quoteSpanIn } from "../../src/flow-tools/quotes.js";

describe("matching a quote against the caller's words", () => {
  it("ignores case, whitespace and punctuation on both sides", () => {
    expect(quoteSpanIn("Yes, that works.", "yes that works")).toBe("Yes, that works");
    expect(quoteSpanIn("yes that works", "Yes,   THAT works!")).toBe("yes that works");
    expect(quoteSpanIn("We don't have employees.", "we dont have employees")).toBe("We don't have employees");
    expect(normalizeQuote("  It's  March-2027! ")).toBe("its march 2027");
  });

  it("still requires the words whole and in the same order", () => {
    expect(quoteSpanIn("Yes, that works.", "that works yes")).toBeNull();
    expect(quoteSpanIn("We have 500 employees.", "50 employees")).toBeNull();
    expect(quoteSpanIn("We have 50 employees.", "have 50")).toBe("have 50");
    expect(quoteSpanIn("Call me Friday.", "call me friday at 3")).toBeNull();
    expect(quoteSpanIn("anything", "  ,. ")).toBeNull();
  });

  it("returns the caller's own text for the span from the first turn that holds it", () => {
    const turns = ["Hello there.", "Our renewal, I think, is in March 2027."];
    expect(findQuoteInCallerWords(turns, "our renewal i think is in march 2027")).toBe("Our renewal, I think, is in March 2027");
    expect(findQuoteInCallerWords(turns, "renewal is in March")).toBeNull();
  });
});
