import { afterEach, describe, expect, it } from "vitest";
import {
  PROMPT_LAYERS,
  PromptSetupRegistry,
  buildSystemPrompt,
  getPromptSetupRegistry,
  resetPromptSetupRegistry,
  type PromptSetup,
} from "../../src/behaviour/prompt/index.js";

const custom = (over: Partial<PromptSetup> = {}): PromptSetup => ({
  id: "my-setup",
  label: "My setup",
  description: "For a test",
  layers: ["rules", "facts"],
  personalityId: "none",
  ...over,
});

afterEach(() => resetPromptSetupRegistry());

describe("prompt setup registry", () => {
  it("lists the shipped setups first, marked as shipped, with the default selected", () => {
    const registry = getPromptSetupRegistry();
    const entries = registry.list();
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(["playbook-full", "playbook-warm", "playbook-brisk", "rules-and-personality", "rules-only", "floor-only", "lab-natural"]));
    expect(entries.every((e) => e.shipped)).toBe(true);
    expect(registry.selectedId()).toBe("playbook-full");
  });

  it("ships setups that match the requested definitions", () => {
    const registry = getPromptSetupRegistry();
    expect(registry.get("playbook-full")?.layers).toEqual([...PROMPT_LAYERS]);
    expect(registry.get("playbook-warm")?.personalityId).toBe("warm-conversational");
    expect(registry.get("playbook-brisk")?.personalityId).toBe("brisk-direct");
    expect(registry.get("rules-and-personality")?.layers.slice().sort()).toEqual(["disclosure", "facts", "flow", "identity", "personality", "rules"]);
    expect(registry.get("rules-only")?.layers.slice().sort()).toEqual(["disclosure", "facts", "identity", "rules"]);
    expect(registry.get("floor-only")?.layers).not.toContain("rules");
  });

  it("selects an existing setup and refuses an unknown one", () => {
    const registry = getPromptSetupRegistry();
    expect(registry.select("rules-only").id).toBe("rules-only");
    expect(registry.selectedId()).toBe("rules-only");
    expect(() => registry.select("nope")).toThrow("setup_unknown:nope");
    expect(registry.selectedId()).toBe("rules-only");
  });

  it("builds from the selected setup by id", () => {
    const registry = getPromptSetupRegistry();
    registry.select("floor-only");
    const built = buildSystemPrompt(registry.selectedId(), { direction: "outbound" });
    expect(built.setupId).toBe("floor-only");
  });

  it("registers a custom setup, lists it after the shipped ones, and builds it by id", () => {
    const registry = getPromptSetupRegistry();
    registry.register(custom());
    const entries = registry.list();
    expect(entries.at(-1)).toMatchObject({ id: "my-setup", shipped: false });
    expect(buildSystemPrompt("my-setup", { direction: "inbound" }).sections.map((s) => s.id)).toEqual(["floor", "rules", "facts"]);
  });

  it("lets a custom setup be replaced but never a shipped one", () => {
    const registry = getPromptSetupRegistry();
    registry.register(custom());
    registry.register(custom({ label: "Renamed" }));
    expect(registry.get("my-setup")?.label).toBe("Renamed");
    expect(() => registry.register(custom({ id: "playbook-full" }))).toThrow("setup_is_shipped:playbook-full");
    expect(registry.get("playbook-full")?.label).not.toBe("My setup");
  });

  it("validates id format, label, layers and personality", () => {
    const registry = getPromptSetupRegistry();
    expect(() => registry.register(custom({ id: "Not Kebab" }))).toThrow("setup_id_invalid");
    expect(() => registry.register(custom({ id: "-leading" }))).toThrow("setup_id_invalid");
    expect(() => registry.register(custom({ id: "double--dash" }))).toThrow("setup_id_invalid");
    expect(() => registry.register(custom({ label: " " }))).toThrow("setup_label_missing");
    expect(() => registry.register(custom({ layers: ["rules", "bogus" as never] }))).toThrow("setup_layer_unknown:bogus");
    expect(() => registry.register(custom({ layers: ["rules", "rules"] }))).toThrow("setup_layer_duplicate:rules");
    expect(() => registry.register(custom({ personalityId: "pirate" }))).toThrow("setup_personality_unknown:pirate");
    expect(registry.get("my-setup")).toBeUndefined();
  });

  it("accepts every known personality and none", () => {
    const registry = getPromptSetupRegistry();
    for (const id of ["steady-professional", "warm-conversational", "brisk-direct", "none"]) {
      registry.register(custom({ id: `with-${id}`, personalityId: id }));
    }
    expect(registry.list().filter((e) => !e.shipped)).toHaveLength(4);
  });

  it("removes only user-defined setups, and falls back to the default if the selected one goes", () => {
    const registry = getPromptSetupRegistry();
    registry.register(custom());
    registry.select("my-setup");
    registry.remove("my-setup");
    expect(registry.get("my-setup")).toBeUndefined();
    expect(registry.selectedId()).toBe("playbook-full");
    expect(() => registry.remove("playbook-full")).toThrow("setup_is_shipped:playbook-full");
    expect(() => registry.remove("my-setup")).toThrow("setup_unknown:my-setup");
  });

  it("parses pasted json: one object, an array, or a wrapper, reporting errors per setup", () => {
    const registry = getPromptSetupRegistry();
    const one = registry.parseSetups(JSON.stringify(custom()));
    expect(one.errors).toEqual([]);
    expect(one.setups.map((s) => s.id)).toEqual(["my-setup"]);

    const many = registry.parseSetups(JSON.stringify({ setups: [custom({ id: "a-one" }), custom({ id: "BAD" }), custom({ id: "playbook-lean" })] }));
    expect(many.setups.map((s) => s.id)).toEqual(["a-one"]);
    expect(many.errors).toEqual(["setup[1]: setup_id_invalid", "setup[2]: setup_is_shipped:playbook-lean"]);

    expect(registry.parseSetups("[1, 2")).toEqual({ setups: [], errors: ["json_invalid"] });
    expect(registry.parseSetups("[null]").errors).toEqual(["setup[0]: setup_not_an_object"]);
    expect(registry.get("my-setup")).toBeUndefined();
  });

  it("imports pasted setups by registering the valid ones", () => {
    const registry = getPromptSetupRegistry();
    const result = registry.importSetups(JSON.stringify([custom({ id: "pasted-one" }), custom({ id: "pasted-two", personalityId: "bogus" })]));
    expect(result.registered.map((s) => s.id)).toEqual(["pasted-one"]);
    expect(result.errors).toHaveLength(1);
    expect(registry.isShipped("pasted-one")).toBe(false);
    expect(registry.list().at(-1)?.id).toBe("pasted-one");
  });

  it("does not let callers change a stored setup by editing what they passed in", () => {
    const registry = getPromptSetupRegistry();
    const input = custom();
    registry.register(input);
    input.layers.push("flow");
    expect(registry.get("my-setup")?.layers).toEqual(["rules", "facts"]);
  });

  it("resets to a fresh registry", () => {
    getPromptSetupRegistry().register(custom());
    getPromptSetupRegistry().select("my-setup");
    resetPromptSetupRegistry();
    expect(getPromptSetupRegistry().get("my-setup")).toBeUndefined();
    expect(getPromptSetupRegistry().selectedId()).toBe("playbook-full");
  });

  it("gives separate registries separate state", () => {
    const a = new PromptSetupRegistry();
    const b = new PromptSetupRegistry();
    a.register(custom());
    expect(b.get("my-setup")).toBeUndefined();
  });
});
