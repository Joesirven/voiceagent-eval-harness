/**
 * Copies src/flow-tools/catalog.json into the flows editor clone, where the editor
 * reads it when it is opened on its own (not inside the console).
 *
 * Usage: tsx scripts/flows-editor/sync-catalog.ts [editor-directory]
 * The editor directory is the first argument, else VOICE_HARNESS_FLOWS_EDITOR_DIR, else
 * /Users/patluisexample/Projects/pipecat-flows-editor.
 *
 * The check is tolerant: any parsed object with a tools array is accepted, and
 * unknown fields are ignored. On success the script prints the destination and one
 * line with the tool count and the catalog version.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncResult {
  destination: string;
  toolCount: number;
  version: unknown;
  summary: string;
}

/** Copies the catalog file into the editor directory. Throws an Error whose message is one line. */
export function syncCatalog(sourceFile: string, editorDir: string): SyncResult {
  if (!existsSync(sourceFile)) throw new Error(`catalog not found: ${sourceFile}`);
  const text = readFileSync(sourceFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`catalog is not valid JSON: ${(error as Error).message.split("\n")[0]}`);
  }
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) throw new Error("catalog has no tools array");
  const version = (parsed as { version?: unknown }).version;
  const destination = join(editorDir, "public", "crm", "tool-catalog.json");
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, text);
  } catch (error) {
    throw new Error(`cannot write ${destination}: ${(error as Error).message.split("\n")[0]}`);
  }
  const versionText = version === undefined ? "unknown" : String(version);
  return {
    destination,
    toolCount: tools.length,
    version,
    summary: `catalog: ${tools.length} tools, version ${versionText}`,
  };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = join(root, "src", "flow-tools", "catalog.json");
  const editorDir = process.argv[2] || process.env.VOICE_HARNESS_FLOWS_EDITOR_DIR || "/Users/patluisexample/Projects/pipecat-flows-editor";
  try {
    const result = syncCatalog(source, editorDir);
    console.log(result.destination);
    console.log(result.summary);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
