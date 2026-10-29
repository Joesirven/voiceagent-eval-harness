/**
 * Starts the standard console's bot with credentials read the way the dev server reads them
 * (CRM_DEV_ENV_FILE), the harness's own agent instruction and opening line, and an
 * allowlisted environment. Nothing secret is printed or written.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAzureCredentials, loadDeepgramCredentials } from "../src/connectors/credentials.js";
import { INBOUND_AI_DISCLOSURE, INBOUND_RECORDING_DISCLOSURE } from "../src/compliance/disclosures.js";
import { buildAgentSystemInstruction } from "../src/modules/agent-instructions.js";
import { buildLeadContextPacket } from "../src/memory/context.js";
import { deepgramReplyDeployment } from "../src/server/voice/path-model-choices.js";
import { ensurePlayLeads } from "../src/server/play-wiring.js";
import { getLead } from "../src/store/lead-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.CONSOLE_STANDARD_PYTHON ?? "/tmp/crm-console-standard-venv/bin/python";
const port = process.env.CONSOLE_STANDARD_BOT_PORT ?? "4352";
// Only the console page may call the bot from a browser; the runner otherwise allows every origin.
const pagePort = process.env.CONSOLE_STANDARD_PAGE_PORT ?? "4351";

ensurePlayLeads();
const lead = getLead("lead-1");
if (!lead) throw new Error("lead_missing");
const disclosure = `${INBOUND_AI_DISCLOSURE} ${INBOUND_RECORDING_DISCLOSURE}`;
const instructions = buildAgentSystemInstruction("default", { leadFirstName: lead.name.trim().split(/\s+/)[0] ?? lead.name, direction: "inbound", disclosure }, buildLeadContextPacket(lead));
const azure = loadAzureCredentials();
const reply = deepgramReplyDeployment(azure.replyDeployment);

const child = spawn(python, ["-u", join(here, "bot", "bot.py"), "-t", "webrtc", "--host", "127.0.0.1", "--port", port, "--allowed-origins", `http://127.0.0.1:${pagePort}`], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    PYTHONIOENCODING: "utf-8",
    DEEPGRAM_API_KEY: loadDeepgramCredentials().apiKey,
    AZURE_FOUNDRY_URL: azure.foundryUrl,
    AZURE_FOUNDRY_KEY: azure.apiKey,
    ...(reply ? { AZURE_REPLY_DEPLOYMENT: reply } : {}),
    ...(process.env.CONSOLE_STANDARD_HARNESS_URL ? { CONSOLE_STANDARD_HARNESS_URL: process.env.CONSOLE_STANDARD_HARNESS_URL } : {}),
    AGENT_INSTRUCTIONS: instructions,
    AGENT_DISCLOSURE: disclosure,
    CRM_DECISION_TREE: process.env.CRM_DECISION_TREE ?? join(here, "..", "src", "decision-tree", "full-tree.json"),
    ...(process.env.CRM_FLOW_FILE ? { CRM_FLOW_FILE: process.env.CRM_FLOW_FILE } : {}),
    // Demo values for the quote prototype flow: names only, no credentials.
    CRM_DEMO_PRODUCER: process.env.CRM_DEMO_PRODUCER ?? "Dana",
    CRM_DEMO_AGENCY: process.env.CRM_DEMO_AGENCY ?? "Example Mutual Insurance",
    CRM_DEMO_PRODUCER_AVAILABLE: process.env.CRM_DEMO_PRODUCER_AVAILABLE ?? "false",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
console.log(`standard console bot starting on 127.0.0.1:${port} (pid ${child.pid})`);
