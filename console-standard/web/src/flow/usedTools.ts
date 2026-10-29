function unquote(raw: string): string {
  let v = raw.trim();
  const hash = v.search(/\s#/);
  if (hash >= 0 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
  return v;
}

/**
 * A tiny tolerant reader limited to the structure nodes: <name>: functions: - name: <tool>.
 * Returns the function names each node uses. Anything it does not understand is skipped, never thrown.
 */
export function functionNamesByNode(yaml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const lines = yaml.replace(/\r/g, "").split("\n");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => l.trim() === "" || l.trim().startsWith("#");
  let i = lines.findIndex((l) => /^nodes\s*:\s*(#.*)?$/.test(l));
  if (i < 0) return out;
  i += 1;
  let nodeIndent = -1;
  let node: string | null = null;
  let fnIndent = -1; // indent of the "functions:" key while inside it, else -1
  let itemKeyIndent = -1; // indent of keys inside the current list item
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) break; // left the nodes block
    const text = line.trim();
    if (nodeIndent < 0) nodeIndent = ind;
    if (ind <= nodeIndent && !text.startsWith("- ")) {
      const m = /^("[^"]*"|'[^']*'|[^:#]+?)\s*:\s*(.*)$/.exec(text);
      if (ind === nodeIndent && m) { node = unquote(m[1]); out[node] ??= []; fnIndent = -1; itemKeyIndent = -1; }
      continue;
    }
    if (node === null) continue;
    if (fnIndent >= 0) {
      const dash = text.startsWith("- ") || text === "-";
      if (ind < fnIndent || (ind === fnIndent && !dash)) fnIndent = -1; // block ended; fall through to key check
      else {
        if (dash) {
          itemKeyIndent = ind + (text.length - text.slice(1).trimStart().length);
          const rest = text.slice(1).trim();
          const m = /^name\s*:\s*(.+)$/.exec(rest);
          if (m) out[node].push(unquote(m[1]));
        } else if (ind === itemKeyIndent) {
          const m = /^name\s*:\s*(.+)$/.exec(text);
          if (m) out[node].push(unquote(m[1]));
        }
        continue;
      }
    }
    if (/^functions\s*:\s*(#.*)?$/.test(text)) { fnIndent = ind; itemKeyIndent = -1; }
  }
  return out;
}

/** For each tool name, the node names whose functions use it. */
export function usedInFlow(yaml: string, toolNames: string[]): Record<string, string[]> {
  const byNode = functionNamesByNode(yaml);
  const used: Record<string, string[]> = {};
  for (const tool of toolNames) used[tool] = Object.keys(byNode).filter((n) => byNode[n].includes(tool));
  return used;
}
