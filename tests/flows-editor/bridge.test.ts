import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const python = process.env.VOICE_HARNESS_PIPECAT_PYTHON ?? "/tmp/voice-harness-pipecat-venv/bin/python";
const root = resolve(__dirname, "..", "..");
const script = join(root, "scripts", "flows-editor", "flow_bridge.py");
const sample = join(root, "scripts", "flows-editor", "samples", "three-node-from-real-tree.flow.yaml");

function bridge(args: string[]) {
  const result = spawnSync(python, ["-I", script, ...args], { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const message = `    task_messages:\n      - role: developer\n        content: Say hello.\n`;

function flow(body: { initial?: string; nodeA?: string; global?: string }) {
  return [
    `initial_node: ${body.initial ?? "a"}`,
    "nodes:",
    "  a:",
    message + (body.nodeA ?? ""),
    "  b:",
    message,
    body.global ?? "",
  ].join("\n");
}

describe.skipIf(!existsSync(python))("flow bridge", () => {
  let dir: string;
  const runtimeText = "previous runtime contents\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-bridge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function refuse(name: string, text: string, expectInStderr: string[]) {
    const input = join(dir, `${name}.yaml`);
    const runtime = join(dir, "runtime.yaml");
    writeFileSync(input, text);
    writeFileSync(runtime, runtimeText);
    const before = readdirSync(dir).sort();
    const result = bridge(["import", input, "--to", runtime]);
    expect(result.status).not.toBe(0);
    for (const needle of expectInStderr) expect(result.stderr).toContain(needle);
    expect(readFileSync(runtime, "utf8")).toBe(runtimeText);
    expect(readdirSync(dir).sort()).toEqual(before);
    return result;
  }

  it("round trips the sample with identical text", () => {
    const exported = bridge(["export", sample, dir]);
    expect(exported.status).toBe(0);
    const editorFile = join(dir, "three-node-from-real-tree.flow.yaml");
    expect(readFileSync(editorFile, "utf8")).toBe(readFileSync(sample, "utf8"));
    const runtime = join(dir, "out", "runtime.yaml");
    const imported = bridge(["import", editorFile, "--to", runtime]);
    expect(imported.status).toBe(0);
    expect(readFileSync(runtime, "utf8")).toBe(readFileSync(sample, "utf8"));
    expect(bridge(["check", sample]).status).toBe(0);
  });

  it("exports JSON as YAML", () => {
    const source = join(dir, "compiled.json");
    writeFileSync(
      source,
      JSON.stringify({ initial_node: "a", nodes: { a: { task_messages: [{ role: "developer", content: "Hi" }] } } }),
    );
    expect(bridge(["export", source, dir]).status).toBe(0);
    const text = readFileSync(join(dir, "compiled.flow.yaml"), "utf8");
    expect(text).toContain("initial_node: a");
    expect(bridge(["check", join(dir, "compiled.flow.yaml")]).status).toBe(0);
  });

  it("refuses a plain transition target that is missing", () => {
    const fn = `    functions:\n      - name: go\n        transition_only: true\n        description: Go.\n        transition_to: ghost\n`;
    refuse("plain", flow({ nodeA: fn }), ["node 'a'", "'go'", "ghost"]);
  });

  it("refuses a branch case target that is missing", () => {
    const fn = `    functions:\n      - name: pick\n        transition_to:\n          field: status\n          cases:\n            ok: ghost\n`;
    refuse("case", flow({ nodeA: fn }), ["node 'a'", "'pick'", "ghost"]);
  });

  it("refuses a branch default that is missing", () => {
    const fn = `    functions:\n      - name: pick\n        transition_to:\n          field: status\n          cases:\n            ok: b\n          default: ghost\n`;
    refuse("default", flow({ nodeA: fn }), ["node 'a'", "branch default", "ghost"]);
  });

  it("refuses a global function target that is missing", () => {
    const global = `global_functions:\n  - name: help\n    transition_to: ghost\n`;
    refuse("global", flow({ global }), ["global function 'help'", "ghost"]);
  });

  it("refuses an initial node that is missing", () => {
    refuse("initial", flow({ initial: "ghost" }), ["initial_node", "ghost"]);
  });

  it("lists every problem, not just the first", () => {
    const fn = `    functions:\n      - name: one\n        transition_to: x1\n      - name: two\n        transition_to: x2\n`;
    refuse("many", flow({ nodeA: fn }), ["x1", "x2"]);
  });

  it("refuses !include", () => {
    refuse("include", "initial_node: a\nnodes:\n  a: !include other.yaml\n", ["include"]);
  });

  it("refuses old format JSON with nodes as a list", () => {
    const input = join(dir, "old.json");
    const runtime = join(dir, "runtime.yaml");
    writeFileSync(input, JSON.stringify({ nodes: [{ id: "a" }], edges: [] }));
    writeFileSync(runtime, runtimeText);
    const result = bridge(["import", input, "--to", runtime]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("old editor JSON format");
    expect(readFileSync(runtime, "utf8")).toBe(runtimeText);
  });

  it("warns about a dotted function name but succeeds", () => {
    const fn = `    functions:\n      - name: open.go\n        transition_only: true\n        description: Go.\n        transition_to: b\n`;
    const input = join(dir, "dotted.yaml");
    const runtime = join(dir, "runtime.yaml");
    writeFileSync(input, flow({ nodeA: fn }));
    const result = bridge(["import", input, "--to", runtime]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/^warning: .*open\.go/m);
    expect(existsSync(runtime)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("warns about single brace placeholders", () => {
    const input = join(dir, "brace.yaml");
    writeFileSync(input, flow({}).replace("Say hello.", "Say hello {firstName}."));
    const result = bridge(["check", input]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("warning:");
    expect(result.stderr).toContain("{firstName}");
  });

  it("refuses a node name written twice", () => {
    const text = "initial_node: a\nnodes:\n  a:\n" + message + "  a:\n" + message;
    refuse("duplicate-node", text, ["duplicate key 'a'"]);
    const input = join(dir, "dup.yaml");
    writeFileSync(input, text);
    expect(bridge(["check", input]).status).toBe(1);
  });

  it("refuses a top level key written twice", () => {
    const text = flow({}).replace("initial_node: a", "initial_node: a\ninitial_node: b");
    refuse("duplicate-top", text, ["duplicate key 'initial_node'"]);
  });

  it("writes through a symlink and keeps the file mode", () => {
    const real = join(dir, "real.yaml");
    const link = join(dir, "link.yaml");
    const input = join(dir, "in.yaml");
    writeFileSync(real, "orig\n");
    chmodSync(real, 0o644);
    symlinkSync(real, link);
    writeFileSync(input, flow({}));
    expect(bridge(["import", input, "--to", link]).status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(flow({}));
    expect(statSync(real).mode & 0o777).toBe(0o644);
  });

  it("gives a new file the default mode, not owner-only", () => {
    const input = join(dir, "in.yaml");
    const runtime = join(dir, "fresh.yaml");
    writeFileSync(input, flow({}));
    expect(bridge(["import", input, "--to", runtime]).status).toBe(0);
    const mask = process.umask();
    expect(statSync(runtime).mode & 0o777).toBe(0o666 & ~mask);
  });

  it("reports write failures on one line without a traceback", () => {
    const input = join(dir, "in.yaml");
    writeFileSync(input, flow({}));
    const asDirectory = join(dir, "adir");
    mkdirSync(asDirectory);
    const longName = join(dir, "x".repeat(300));
    for (const target of [asDirectory, longName]) {
      const result = bridge(["import", input, "--to", target]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot write");
      expect(result.stderr).not.toContain("Traceback");
    }
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("writes to VOICE_HARNESS_FLOW_FILE when --to is absent", () => {
    const input = join(dir, "in.yaml");
    const runtime = join(dir, "env-target.yaml");
    writeFileSync(input, flow({}));
    const result = spawnSync(python, ["-I", script, "import", input], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, VOICE_HARNESS_FLOW_FILE: runtime },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(runtime, "utf8")).toBe(flow({}));
  });

  it("refuses a direct function without a handler, naming it, and leaves the runtime file alone", () => {
    const handlers = join(dir, "handlers.py");
    writeFileSync(handlers, "async def known_tool(flow_manager):\n    return {}, None\n");
    const direct = (name: string) =>
      flow({ nodeA: `    functions:\n      - name: ${name}\n        transition_to: b\n` });
    const input = join(dir, "in.yaml");
    const runtime = join(dir, "runtime.yaml");
    writeFileSync(runtime, "orig");
    writeFileSync(input, direct("added_in_editor"));
    const refused = bridge(["import", input, "--to", runtime, "--handlers", handlers]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("added_in_editor");
    expect(readFileSync(runtime, "utf8")).toBe("orig");
    writeFileSync(input, direct("known_tool"));
    expect(bridge(["import", input, "--to", runtime, "--handlers", handlers]).status).toBe(0);
    const transitionOnly = flow({
      nodeA:
        "    functions:\n      - name: go\n        transition_only: true\n        description: Go on.\n        transition_to: b\n",
    });
    writeFileSync(input, transitionOnly);
    expect(bridge(["check", input, "--handlers", handlers]).status).toBe(0);
  });
});
