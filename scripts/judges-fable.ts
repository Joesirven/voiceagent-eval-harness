/**
 * The Fable analysis over stored call records.
 *
 *   tsx scripts/judges-fable.ts [--records-dir DIR] [--models id,id] [--hand-verdicts FILE]
 *                               [--from DIR] [--min-support N] [--concurrency N]
 *
 * Reads call records from the harness records directory (default: the one the
 * harness writes to), rebuilds the decision cases from them, optionally asks the
 * decision models in --models (catalog ids, for example jev,openai-decisions;
 * mocks stand in for any without a credential) the same questions, asks Fable
 * for its own answer to every case, and writes the report, the confusion
 * tables, the recommended bars and the worksheet of disagreements under
 * data/judges/fable-<timestamp>/ (data/ is git-ignored).
 *
 * --hand-verdicts FILE reads a filled-in worksheet.json and recomputes the bars.
 * With --from DIR (an earlier output directory) Fable is not asked again: the
 * saved cases and labels are reused, so a recomputation costs nothing.
 *
 * Past-call words go to Fable redacted, and Fable 5.1 keeps them for 30 days.
 * Prints counts only, never conversation text.
 *
 * Models go through the connectors (Vercel AI Gateway key AI_GATEWAY_API_KEY,
 * from the file named by VOICE_HARNESS_DEV_ENV_FILE).
 *
 * Exit codes: 0 done, 1 failed, 2 the Gateway key is missing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDecisionModelCatalog } from "../src/decision-models/catalog.js";
import { redactTurns } from "../src/decision-models/redact.js";
import type { DecisionModel } from "../src/decision-models/types.js";
import { buildJudgeJsonClient, GATEWAY_KEY_MISSING_MESSAGE } from "../src/judging/offline/connector-client.js";
import {
  analyze,
  buildWorksheet,
  casesFromRecords,
  ClaudeFableLabeler,
  labelCases,
  readHandVerdicts,
  renderReport,
  runModelsOnCases,
  writeWorksheet,
  type DecisionCase,
  type FableLabel,
} from "../src/judging/offline/fable-analysis.js";
import { recordStore } from "../src/trace/records.js";

interface Args {
  recordsDir?: string;
  models: string[];
  handVerdicts?: string;
  from?: string;
  minSupport?: number;
  concurrency?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { models: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error("bad_arguments");
    if (flag === "--records-dir") args.recordsDir = value;
    else if (flag === "--models") args.models = value.split(",").map((m) => m.trim()).filter(Boolean);
    else if (flag === "--hand-verdicts") args.handVerdicts = value;
    else if (flag === "--from") args.from = value;
    else if (flag === "--min-support") args.minSupport = Number(value);
    else if (flag === "--concurrency") args.concurrency = Number(value);
    else throw new Error("bad_arguments");
  }
  for (const n of [args.minSupport, args.concurrency]) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new Error("bad_arguments");
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const reuse = args.from !== undefined;

  // The Gateway key first: without it nothing else is worth touching. A recomputation does not need it.
  let claude;
  if (!reuse) {
    try {
      claude = buildJudgeJsonClient();
    } catch (err) {
      console.error(`${GATEWAY_KEY_MISSING_MESSAGE} ${err instanceof Error ? err.message : "unknown"}`);
      return 2;
    }
  }

  let cases: DecisionCase[];
  let labels: Record<string, FableLabel>;
  let labelFailures: Record<string, string> = {};
  let recordsRead = 0;
  let callRecords = 0;

  if (reuse) {
    const from = resolve(args.from!);
    cases = JSON.parse(readFileSync(join(from, "cases.json"), "utf8")) as DecisionCase[];
    labels = JSON.parse(readFileSync(join(from, "labels.json"), "utf8")) as Record<string, FableLabel>;
  } else {
    if (args.recordsDir) recordStore.setDir(args.recordsDir);
    const records = recordStore.list();
    recordsRead = records.length;
    callRecords = records.filter((r) => r.kind === "call").length;
    cases = casesFromRecords(records);
    if (cases.length === 0) {
      console.log(`records read=${recordsRead} call records=${callRecords} decision cases=0; nothing to analyze in ${recordStore.dir}`);
      return 0;
    }

    if (args.models.length > 0) {
      const catalog = createDecisionModelCatalog();
      const models: DecisionModel[] = [];
      for (const id of args.models) {
        const found = catalog.get(id);
        if (!found) throw new Error(`unknown_model:${id.replace(/[^\w:./-]/g, "")}`);
        if (found.fellBackToMock) console.log(`model ${found.model.id}: no credential, a mock answers instead`);
        models.push(found.model);
      }
      cases = await runModelsOnCases(cases, models, { concurrency: args.concurrency });
    }

    const labeler = new ClaudeFableLabeler({ client: claude! });
    const run = await labelCases(cases, labeler, { concurrency: args.concurrency });
    labels = run.labels;
    labelFailures = run.failures;
  }

  const handVerdicts = args.handVerdicts ? readHandVerdicts(readFileSync(args.handVerdicts, "utf8")) : {};
  const result = analyze(cases, labels, handVerdicts, { minSupport: args.minSupport });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(process.cwd(), "data", "judges", `fable-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), renderReport(result));
  writeFileSync(
    join(dir, "confusion.json"),
    `${JSON.stringify(Object.fromEntries(result.models.map((m) => [m.modelId, m.confusion])), null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "bars.json"),
    `${JSON.stringify(Object.fromEntries(result.models.map((m) => [m.modelId, m.bars])), null, 2)}\n`,
  );
  writeFileSync(join(dir, "analysis.json"), `${JSON.stringify(result, null, 2)}\n`);
  // Saved with redacted conversations, so a later recomputation never needs the originals.
  writeFileSync(
    join(dir, "cases.json"),
    `${JSON.stringify(cases.map((c) => ({ ...c, transcript: redactTurns(c.transcript) })), null, 2)}\n`,
  );
  writeFileSync(join(dir, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  writeWorksheet(dir, buildWorksheet(cases, labels, result, handVerdicts));

  const disagreements = result.models.reduce((n, m) => n + m.disagreements.length, 0);
  const barsFound = result.models.reduce((n, m) => n + m.bars.filter((b) => b.bar !== null).length, 0);
  const barsTotal = result.models.reduce((n, m) => n + m.bars.length, 0);
  console.log(
    (reuse ? "reused saved cases and labels; " : `records read=${recordsRead} call records=${callRecords}; `) +
      `cases=${result.casesTotal} labelled by Fable=${result.casesLabelled} of ${result.casesTotal}` +
      (Object.keys(labelFailures).length > 0 ? ` (${Object.keys(labelFailures).length} could not be labelled)` : "") +
      `; models=${result.models.length}; disagreements=${disagreements}, waiting for a hand verdict=${result.waitingCases} cases; ` +
      `bars found=${barsFound} of ${barsTotal}`,
  );
  console.log(`written to ${dir}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  // Our own error codes carry no secrets; anything else is reduced to a fixed label.
  const message = err instanceof Error && /^[a-z0-9_:]+$/.test(err.message) ? err.message : "unknown";
  console.error(`judges-fable failed: ${message}`);
  process.exitCode = 1;
}
