import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncCatalog } from "../../scripts/flows-editor/sync-catalog.js";

const fixture = join(import.meta.dirname, "fixtures", "catalog.synthetic.json");
let dir: string;
let source: string;
let editorDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-catalog-"));
  source = join(dir, "catalog.json");
  editorDir = join(dir, "editor");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("syncCatalog", () => {
  it("copies the file unchanged and reports the tool count and version", () => {
    const text = readFileSync(fixture, "utf8");
    writeFileSync(source, text);
    const result = syncCatalog(source, editorDir);
    expect(result.toolCount).toBe(7);
    expect(result.version).toBe(1);
    expect(result.summary).toBe("catalog: 7 tools, version 1");
    expect(result.destination).toBe(join(editorDir, "public", "crm", "tool-catalog.json"));
    expect(readFileSync(result.destination, "utf8")).toBe(text);
  });

  it("accepts a catalog without a version or credentials", () => {
    writeFileSync(source, JSON.stringify({ tools: [{ name: "a_tool" }] }));
    expect(syncCatalog(source, editorDir).summary).toBe("catalog: 1 tools, version unknown");
  });

  it("fails with one line when there is no tools array, and writes nothing", () => {
    writeFileSync(source, JSON.stringify({ version: 1, templates: {} }));
    expect(() => syncCatalog(source, editorDir)).toThrow("catalog has no tools array");
    writeFileSync(source, JSON.stringify({ version: 1, tools: {} }));
    expect(() => syncCatalog(source, editorDir)).toThrow("catalog has no tools array");
    writeFileSync(source, "[]");
    expect(() => syncCatalog(source, editorDir)).toThrow("catalog has no tools array");
    writeFileSync(source, "null");
    expect(() => syncCatalog(source, editorDir)).toThrow("catalog has no tools array");
    expect(existsSync(editorDir)).toBe(false);
  });

  it("fails with one line for a missing file or invalid JSON", () => {
    expect(() => syncCatalog(source, editorDir)).toThrow(/^catalog not found: /);
    writeFileSync(source, "{ nope");
    try {
      syncCatalog(source, editorDir);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^catalog is not valid JSON: /);
      expect(message).not.toContain("\n");
    }
  });
});
