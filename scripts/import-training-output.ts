/**
 * One-time import of the reviewed training outputs into the harness's behaviour data files.
 *
 *   tsx scripts/import-training-output.ts <training-archive output directory>
 *
 * Reads voice-agent-playbook.md, enforcement.md and grading-rubric.md and writes
 * src/behaviour/data/{playbook,enforcement-rules,grading-rubric}.json plus
 * tests/behaviour/corpus/candidates.json (quoted lines for hand tagging).
 *
 * The data files are the harness's source of truth once imported. Re-running this
 * overwrites them, so hand edits made after an import are lost: edit the markdown
 * and re-import, or edit the data and do not re-import.
 *
 * The "existing harness check" column of the enforcement table is deliberately not
 * imported: it described an older harness and is re-derived from the code instead.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const outputDir = process.argv[2];
if (!outputDir) {
  console.error("usage: tsx scripts/import-training-output.ts <training-archive output directory>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;

function read(name: string): string {
  return readFileSync(join(outputDir, name), "utf8");
}

function write(rel: string, value: unknown): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface Table {
  /** Nearest preceding headings, outermost first. */
  headings: string[];
  header: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseTables(markdown: string): Table[] {
  const lines = markdown.split("\n");
  const tables: Table[] = [];
  const headings: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = (h[1] ?? "").length;
      headings.length = level - 1;
      headings[level - 1] = (h[2] ?? "").trim();
      continue;
    }
    if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? "").startsWith("|")) {
        rows.push(splitRow(lines[j] ?? ""));
        j += 1;
      }
      tables.push({ headings: [...headings], header, rows });
      i = j - 1;
    }
  }
  return tables;
}

function key(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w[0]?.toUpperCase() + w.slice(1))).join("");
}

function stripBold(text: string): string {
  return text.replace(/\*\*/g, "");
}

/** Every double-quoted span in a cell, curly or straight. */
function quoted(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["“]([^"”]{3,}?)["”]/g)) out.push((m[1] ?? "").trim());
  return out;
}

// ---------------------------------------------------------------- playbook

const playbookMd = read("voice-agent-playbook.md");
const corePara = playbookMd.match(/## What the agent is, in one paragraph[^\n]*\n\n([^\n]+)/)?.[1] ?? "";

const AGENT_LINE_COLUMNS = new Set(["agentLine", "lineOrRule", "question", "agentLineOrRule", "agentBehaviourOrLine", "whatTheAgentDoes"]);

interface PlaybookItem {
  id: string;
  fields: Record<string, string>;
  source: string;
}
interface PlaybookSection {
  heading: string;
  columns: string[];
  items: PlaybookItem[];
}

const sections: PlaybookSection[] = [];
const candidates: { id: string; line: string; column: string }[] = [];

for (const t of parseTables(playbookMd)) {
  if (t.header[0] === "Trigger or topic") continue; // retrieval index, rebuilt from ids
  const columns = t.header.map(key);
  const heading = t.headings.slice(1).join(" > ");
  const items: PlaybookItem[] = [];
  for (const row of t.rows) {
    const fields: Record<string, string> = {};
    columns.forEach((c, i) => {
      fields[c] = stripBold(row[i] ?? "");
    });
    const first = row[0] ?? "";
    const id = /^[A-Z][A-Za-z-]+-\d+$/.test(first) ? first : "";
    const source = fields.source ?? "";
    delete fields.source;
    if (id) {
      for (const [c, v] of Object.entries(fields)) {
        if (!AGENT_LINE_COLUMNS.has(c)) continue;
        for (const q of quoted(v)) candidates.push({ id, line: q, column: c });
      }
    }
    items.push({ id, fields, source });
  }
  sections.push({ heading, columns, items });
}

write("src/behaviour/data/playbook.json", {
  generatedFrom: "voice-agent-playbook.md",
  core: stripBold(corePara),
  sections,
});

// ------------------------------------------------------------- enforcement

const enforcementMd = read("enforcement.md");
const ruleTable = parseTables(enforcementMd).find((t) => t.header[0] === "Rule");
if (!ruleTable) throw new Error("rule table not found in enforcement.md");

const rules = ruleTable.rows.map((r) => {
  const [rule = "", example = "", sources = "", layer = "", , proposed = "", tests = ""] = r;
  const m = rule.match(/^\*\*((?:Never|Producer-only)-\d+)\*\*\s*(.*)$/);
  if (!m) throw new Error(`unparsed rule cell: ${rule.slice(0, 40)}`);
  const id = m[1] ?? "";
  const statement = stripBold(m[2] ?? "");
  const layers = [
    /runtime check/i.test(layer) ? "runtime" : null,
    /prompt instruction/i.test(layer) ? "prompt" : null,
    /transcript check/i.test(layer) ? "transcript" : null,
  ].filter((x): x is string => x !== null);
  const scenarioNumbers = [...tests.matchAll(/(?:^|[;.]\s*)(\d+)\.\s/g)].map((x) => Number(x[1]));
  const scenarioTitles = tests
    .split(/;\s*/)
    .map((s) => s.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  for (const q of quoted(example)) candidates.push({ id, line: q, column: "forbiddenExample" });
  return {
    id,
    kind: id.startsWith("Never") ? "never" : "producer_only",
    statement,
    pendingLegalResearch: /pending legal research/i.test(rule),
    example: stripBold(example),
    sources: stripBold(sources),
    layers,
    proposedCheck: stripBold(proposed),
    scenarioNumbers,
    scenarioTitles,
  };
});

write("src/behaviour/data/enforcement-rules.json", { generatedFrom: "enforcement.md", rules });

// ------------------------------------------------------------------ rubric

const rubricMd = read("grading-rubric.md");
const rubricTables = parseTables(rubricMd);
const gateTable = rubricTables.find((t) => t.header[0] === "Item" && t.header[1] === "Gate");
const criterionTable = rubricTables.find((t) => t.header[0] === "Item" && t.header[1] === "Criterion");
if (!gateTable || !criterionTable) throw new Error("rubric tables not found");

const gates = gateTable.rows.map(([id = "", gate = "", checkedBy = "", ruleIds = "", source = ""]) => ({
  id,
  statement: stripBold(gate),
  checkedBy: stripBold(checkedBy),
  rules: ruleIds,
  source: stripBold(source),
}));
const criteria = criterionTable.rows.map(([id = "", criterion = "", metWhen = "", source = ""]) => ({
  id,
  title: stripBold(criterion),
  metWhen: stripBold(metWhen),
  source: stripBold(source),
}));
write("src/behaviour/data/grading-rubric.json", { generatedFrom: "grading-rubric.md", gates, criteria });

write("tests/behaviour/corpus/candidates.json", candidates);
console.log(
  `playbook sections=${sections.length} items=${sections.reduce((n, s) => n + s.items.length, 0)}; rules=${rules.length}; gates=${gates.length}; criteria=${criteria.length}; quoted candidates=${candidates.length}`,
);
