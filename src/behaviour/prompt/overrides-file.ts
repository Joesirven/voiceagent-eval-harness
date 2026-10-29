/**
 * A prompt written as markdown, one "## <layer id>" section per prompt layer, read
 * into a setup's overrides. The file lives beside the other prompt data
 * (src/behaviour/data). Bracketed slots in it ([agency name], [X-date] and the
 * rest) are filled at build time by the same slot filler as the playbook text.
 *
 * Rules: every heading must name a prompt layer; the disclosure layer is never
 * overridden (its words are checked by the harness); text before the first
 * heading is a comment and is dropped.
 */

import { readFileSync } from "node:fs";
import { PROMPT_LAYERS, type PromptLayerId } from "./types.js";

const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADING = /^## ([a-z]+)\s*$/;

export function isOverridesFileName(name: unknown): name is string {
  return typeof name === "string" && FILE_NAME.test(name);
}

/** Splits the markdown into overrides by layer. Throws a short code on a bad heading. */
export function parseOverridesMarkdown(text: string): Partial<Record<PromptLayerId, string>> {
  const out: Partial<Record<PromptLayerId, string>> = {};
  let current: PromptLayerId | undefined;
  let lines: string[] = [];
  const close = () => {
    if (!current) return;
    const body = lines.join("\n").trim();
    if (!body) throw new Error(`overrides_section_empty:${current}`);
    out[current] = body;
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    close();
    const layer = heading[1];
    if (!(PROMPT_LAYERS as readonly string[]).includes(layer)) throw new Error(`overrides_layer_unknown:${layer}`);
    if (layer === "disclosure") throw new Error("disclosure_locked");
    if (out[layer as PromptLayerId] !== undefined) throw new Error(`overrides_layer_duplicate:${layer}`);
    current = layer as PromptLayerId;
    lines = [];
  }
  close();
  if (Object.keys(out).length === 0) throw new Error("overrides_file_has_no_sections");
  return out;
}

export function readOverridesFile(name: string): Partial<Record<PromptLayerId, string>> {
  if (!isOverridesFileName(name)) throw new Error(`overrides_file_name_invalid:${name}`);
  let text: string;
  try {
    text = readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8");
  } catch {
    throw new Error(`overrides_file_unreadable:${name}`);
  }
  return parseOverridesMarkdown(text);
}
