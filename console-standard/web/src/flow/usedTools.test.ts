import { describe, expect, it } from "vitest";
import { functionNamesByNode, usedInFlow } from "./usedTools";

const sampleYaml = `name: demo
nodes:
  greeting:
    task_messages:
      - role: system
        content: "Say hello. functions: - name: fake"
    functions:
      - name: write_quote_field
        handler: x
      - name: decide_next
  quoting:
    functions:
      - name: "start_quote"
      - name: write_quote_field
  closing:
    functions: []
`;

describe("used in this flow", () => {
  it("reads the function names of each node", () => {
    expect(functionNamesByNode(sampleYaml)).toEqual({
      greeting: ["write_quote_field", "decide_next"],
      quoting: ["start_quote", "write_quote_field"],
      closing: [],
    });
  });
  it("lists the nodes that use each tool", () => {
    expect(usedInFlow(sampleYaml, ["write_quote_field", "start_quote", "book_producer"])).toEqual({
      write_quote_field: ["greeting", "quoting"],
      start_quote: ["quoting"],
      book_producer: [],
    });
  });
  it("returns nothing for text without nodes", () => {
    expect(functionNamesByNode("")).toEqual({});
    expect(functionNamesByNode("a: b")).toEqual({});
  });
});
