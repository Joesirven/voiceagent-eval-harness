/**
 * Zero-dependency control page server: `pnpm dev`. Local only. The decision module and the judge model are Azure when configured (see live-judge-wiring.ts).
 * One static HTML page plus a small JSON API over the module registry, the
 * agency flag and the trial scenarios.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getHarnessConfig,
  isAiCallingEnabled,
  setAiCallingEnabled,
  setActionJudgeOff,
  setComplianceChecksOff,
  setLegalBlocks,
  setOpeningIdentity,
  setTestPhone,
  setTestSessionId,
  DEMO_OPENING,
} from "../config.js";
import { setIntendedLineMode } from "../decision/engine.js";
import { listLiveDecisionTrees, selectDecisionTree, selectedDecisionTreeId } from "../decision/tree-source.js";
import { getModuleRegistry } from "../modules/registry.js";
import { listScenarios, runScenario } from "../scenarios/trial-scenarios.js";
import {
  assertAzureTalkPath,
  getLiveTestPath,
  liveTestSnapshot,
  setAzureLiveDeployment,
  setLiveTestPath,
  startVapiTestCall,
  type LiveTestPath,
} from "./live-test.js";
import { narrate, recordStore, traceBus, type TraceEvent } from "../trace/index.js";
import { installBehaviourPromptBuilder, PROMPT_SETUP_ENV, selectPromptSetup, selectPromptSetupFromEnv } from "../behaviour/install-prompt.js";
import { getPromptSetupRegistry } from "../behaviour/prompt/setups.js";
import { isLoopbackRequest } from "./voice/loopback.js";
import {
  activeVoiceCallId,
  closeActiveVoiceSession,
  listTalkOrchestrators,
  listVoicePaths,
  selectVoicePath,
  setVoiceLiveDecisionTree,
  setVoiceLiveFlow,
  voiceLiveDecisionTreeOn,
  voiceLiveFlowChoice,
  selectedVoicePath,
  type VoicePathId,
  listStaleOutputDrops,
  selectStaleOutputDrop,
  selectTalkOrchestrator,
  selectedStaleOutputDrop,
  selectedTalkOrchestrator,
  type StaleOutputDropId,
  type TalkOrchestratorId,
} from "./voice/manager.js";
import { recentVoiceErrors, reportVoiceError } from "./voice/voice-errors.js";
import { buildVoiceOptions, chooseDecisionRouter, choosePathModel } from "./voice/voice-options-builder.js";
import { logModuleChanges, settingSource } from "./voice/settings-log.js";
import { loadAzureCatalog } from "../modules/azure-catalog.js";
import { attachVoiceSockets, type VoiceCallHandle } from "./voice/socket-route.js";
import { armHumanTransfer, setTransferRing, transferRingChoice } from "./voice/human-transfer.js";
import { dialingIsDryRun } from "./voice/twilio-transfer-line.js";
import { clearLeadInFlightForPlay, liveTreeDialogs } from "../harness/call-harness.js";
import { currentDecisionTree, ensurePlayLeads, getStartInteractiveCall, listPlayLeads, type InteractiveCall } from "./play-wiring.js";
import { TEST_ONLY_DECISION_MODULE_IDS } from "../decision/modules.js";
import { handleSetupRoute } from "../setups/routes.js";
import { handlePromptRoute } from "./prompt-routes.js";
import { ensureCustomSetupsLoaded } from "../setups/prompt-setup-store.js";
import { handleLeadContextRoute } from "../lead-context/route.js";
import { handleFlowEditorRoute } from "./flow-editor-routes.js";
import { describeRunStore, runStoreLogLine } from "../setups/run-writer.js";
import { azureReadyForNewCall, azureStartupGate, azureStatus, watchAzureFailures } from "./azure-startup-check.js";
import { applyDecisionModuleChoice, DECISION_MODULE_ENV, decisionModuleStatus, installLiveJudge, listDecisionModuleOptions } from "./live-judge-wiring.js";
import { warmUpCall, warmupLogLine } from "./call-warmup.js";
import { handleLeadsRoute } from "./leads-search.js";
import { handleCallsRoute } from "./call-history.js";
import { installObjectivesJudge } from "./objectives-wiring.js";
import { installPostCallScorer } from "./post-call-score-wiring.js";
import { handlePipecatProxy } from "./pipecat-proxy.js";
import { handleRatingRoute } from "./rating-routes.js";
import { handlePipecatTraceRoute } from "./pipecat-trace-route.js";

installBehaviourPromptBuilder();

const here = dirname(fileURLToPath(import.meta.url));
// The control page is the built React front end (web/, `pnpm build:web`); the server only serves its files.
const webDist = join(here, "..", "..", "web", "dist");
const webTypes: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" };
const coreScriptPath = join(here, "live-view-core.js");
const voicePagePath = join(here, "voice", "voice-page.html");
/** Deterministic scenario runner page (test note); it uses only /api/state and /api/scenarios. */
const simulatorPagePath = join(here, "simulator-page.html");
const voiceClientPath = join(here, "voice", "voice-client.js");
/** The interface mock under `/mock`: fake data, no network, served from this folder only (allow-list, no path from the request). */
const mockDir = join(here, "ui-mock");
const mockFiles: Record<string, { file: string; type: string }> = {
  "/mock": { file: "index.html", type: "text/html; charset=utf-8" },
  "/mock/mock.css": { file: "mock.css", type: "text/css; charset=utf-8" },
  "/mock/mock.js": { file: "mock.js", type: "text/javascript; charset=utf-8" },
  "/mock/mock-data.js": { file: "mock-data.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Static pages built with Vite and served from their `dist` folder only: the ten decision tree
 * designs at /tree-designs (`pnpm build:designs`). Asset names come from the directory listing,
 * never from the request path.
 */
const staticApps = [
  { prefix: "/tree-designs", dir: join(here, "..", "..", "designs", "dist"), title: "Decision tree designs", build: "pnpm build:designs" },
];
function serveStaticApp(path: string, res: ServerResponse): boolean {
  const app = staticApps.find((a) => path === a.prefix || path === `${a.prefix}/` || path.startsWith(`${a.prefix}/assets/`));
  if (!app) return false;
  if (!existsSync(join(app.dir, "index.html"))) {
    send(res, 503, `<!doctype html><title>${app.title}</title><p>This page is not built. Run <code>${app.build}</code> and reload.</p>`, "text/html; charset=utf-8");
    return true;
  }
  if (path === app.prefix || path === `${app.prefix}/`) {
    send(res, 200, readFileSync(join(app.dir, "index.html"), "utf8"), "text/html; charset=utf-8");
    return true;
  }
  const assetsDir = join(app.dir, "assets");
  const wanted = basename(path);
  const file = existsSync(assetsDir) ? readdirSync(assetsDir).find((name) => name === wanted) : undefined;
  if (!file) {
    send(res, 404, { error: "not_found" });
    return true;
  }
  const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(readFileSync(join(assetsDir, file)));
  return true;
}

/** Calls started from the page, by call id. Each call runs one caller line at a time. */
interface PlayedCall { call: InteractiveCall; queue: Promise<unknown>; leadId: string; direction: "inbound" | "outbound" }
const playedCalls = new Map<string, PlayedCall>();
const MAX_PLAYED_CALLS = 5;
let playIdleMs = 5 * 60 * 1000;
/** How long a play call may sit without a caller line before it is ended as abandoned (tests shorten it). */
export function setPlayIdleMs(ms: number): void {
  playIdleMs = ms;
}

interface PlayedCallTimer { timer?: NodeJS.Timeout }
const idleTimers = new Map<string, PlayedCallTimer>();

/** Ends a call once and frees its slot; safe to call twice. */
/** Hang up every open play call for one lead so Talk can replace it. */
async function finishPlayedForLead(leadId: string): Promise<void> {
  const ids = [...playedCalls.entries()].filter(([, p]) => p.leadId === leadId).map(([id]) => id);
  for (const id of ids) await finishPlayed(id);
  clearLeadInFlightForPlay(leadId);
}

function listOpenPlayedCalls(): Array<{ callId: string; leadId: string; direction: "inbound" | "outbound" }> {
  return [...playedCalls.entries()].map(([callId, p]) => ({ callId, leadId: p.leadId, direction: p.direction }));
}

async function finishPlayed(callId: string, reason?: "abandoned"): Promise<void> {
  const played = playedCalls.get(callId);
  if (!played) return;
  if (activeVoiceCallId() === callId) closeActiveVoiceSession(reason === "abandoned" ? "play_abandoned" : "play_call_ended");
  playedCalls.delete(callId);
  clearTimeout(idleTimers.get(callId)?.timer);
  idleTimers.delete(callId);
  try {
    await played.queue.catch(() => undefined);
    await played.call.hangUp(reason);
  } catch (err) {
    console.error("could not end play call:", err instanceof Error ? err.message : err);
  }
}

/** Azure stopped working: end every call in progress cleanly, with the reason on the voice session. */
async function endCallsForAzure(): Promise<void> {
  closeActiveVoiceSession("azure_unavailable");
  for (const id of [...playedCalls.keys()]) await finishPlayed(id);
}

function armIdle(callId: string): void {
  const entry = idleTimers.get(callId) ?? {};
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void finishPlayed(callId, "abandoned"), playIdleMs);
  entry.timer.unref();
  idleTimers.set(callId, entry);
}

// A call that reaches an end node is ended (so its record closes) and frees its slot. An open voice
// session is left alone: the voice socket closes it once the closing line has played, and the socket
// closing finishes the call.
traceBus.subscribe((event) => {
  if (event.type !== "disposition" || !event.callId || !playedCalls.has(event.callId)) return;
  if (activeVoiceCallId() === event.callId) return;
  void finishPlayed(event.callId);
});

async function playRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (method === "GET" && path === "/api/play/leads") {
    send(res, 200, await listPlayLeads());
    return true;
  }
  if (method === "GET" && path === "/api/play/open") {
    send(res, 200, listOpenPlayedCalls());
    return true;
  }
  if (method === "POST" && path === "/api/play/hangup-all") {
    const ids = [...playedCalls.keys()];
    for (const id of ids) await finishPlayed(id);
    send(res, 200, { ok: true, ended: ids.length });
    return true;
  }
  if (method !== "POST") return false;
  if (path === "/api/play/start") {
    // Azure is marked as not working: no new call until the check passes again.
    const azure = await azureReadyForNewCall();
    if (!azure.ok) return send(res, 503, { error: "azure_unavailable", code: azure.code, message: azure.message }), true;
  }
  const startCall = getStartInteractiveCall();
  // Refuse every play action until a gated start (compliance checks and a clearance) is installed.
  if (!startCall) return send(res, 503, { error: "play_unavailable_until_gated" }), true;
  if (path === "/api/play/start") {
    const { leadId, direction, voice } = await readJson(req);
    if (typeof leadId !== "string" || !/^[\w-]{1,60}$/.test(leadId)) throw new Error("bad_lead_id");
    if (direction !== "inbound" && direction !== "outbound") throw new Error("bad_direction");
    if (playedCalls.size >= MAX_PLAYED_CALLS) throw new Error("too_many_open_calls");
    ensurePlayLeads();
    await finishPlayedForLead(leadId);
    // Browser Talk needs the Azure live test path; the Vapi path places its own allowlisted phone call instead.
    if (voice === true) assertAzureTalkPath();
    setIntendedLineMode(voice === true);
    let call: InteractiveCall;
    try {
      call = await startCall({ leadId, direction });
    } finally {
      setIntendedLineMode(false);
    }
    // A start a compliance check refused: say which check, and open nothing.
    if (call.status === "blocked") return send(res, 409, { blocked: true, reason: call.blockedReason }), true;
    playedCalls.set(call.callId, { call, queue: Promise.resolve(), leadId, direction });
    armIdle(call.callId);
    send(res, 200, { callId: call.callId, leadId, direction });
    return true;
  }
  const match = path.match(/^\/api\/play\/([\w-]+)\/hangup$/);
  if (!match) return false;
  if (!playedCalls.get(match[1]!)) return send(res, 404, { error: "call_not_found" }), true;
  await finishPlayed(match[1]!);
  send(res, 200, { ok: true });
  return true;
}

/** One caller line, one at a time in the order sent. Resolves with the agent's reply text from the decision step, if any. */
async function sayOnPlayed(callId: string, text: string): Promise<string | undefined> {
  const played = playedCalls.get(callId);
  if (!played) throw new Error("call_not_found");
  const replies: string[] = [];
  const unsubscribe = traceBus.subscribe((e) => {
    const intended = (e.data.result as { text?: unknown } | null)?.text;
    if (e.callId === callId && e.type === "tool_call" && e.data.tool === "intended_agent_line" && typeof intended === "string") {
      replies.push(intended);
    }
  });
  armIdle(callId);
  try {
    const run = played.queue.catch(() => undefined).then(() => played.call.say(text));
    played.queue = run;
    await run;
  } finally {
    unsubscribe();
  }
  if (playedCalls.has(callId)) armIdle(callId);
  return replies.join(" ").trim() || undefined;
}

/** What the voice socket needs to know about a call the page started through the gated harness. */
function voiceHandle(callId: string): VoiceCallHandle | undefined {
  const played = playedCalls.get(callId);
  if (!played) return undefined;
  return {
    call: played.call,
    leadId: played.leadId,
    direction: played.direction,
    say: (text) => sayOnPlayed(callId, text),
    disclosure: () => {
      const first = traceBus.history().find((e) => e.callId === callId && e.type === "tool_call" && e.data.tool === "intended_agent_line");
      const text = (first?.data.result as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : undefined;
    },
    opening: () => {
      const row = traceBus.history().find((e) => e.callId === callId && e.type === "tool_call" && e.data.tool === "expected_opening");
      const r = row?.data.result as { disclosure?: unknown; confirm?: unknown } | null | undefined;
      if (!Array.isArray(r?.disclosure) || !r.disclosure.every((d) => typeof d === "string")) return undefined;
      return { disclosure: r.disclosure as string[], ...(typeof r.confirm === "string" ? { confirm: r.confirm } : {}) };
    },
    onDisconnect: () => void finishPlayed(callId),
    // The opening line is the dialog's turn -1.
    markDisclosureNotSaid: () => void liveTreeDialogs.get(callId)?.markLineNotSaid(-1),
    stopDialog: (reason) => liveTreeDialogs.get(callId)?.stop(reason),
    holdOpen: () => {
      if (playedCalls.has(callId)) armIdle(callId);
    },
  };
}

/** Adds the browser voice websocket to a server. */
export function attachVoice(server: Server): void {
  attachVoiceSockets(server, voiceHandle);
}

function state() {
  const registry = getModuleRegistry();
  const cfg = getHarnessConfig();
  const agencies = new Set([cfg.agencyId, ...Object.keys(cfg.aiCallingByAgency)]);
  return {
    modules: registry.list(),
    selectedModuleId: registry.selectedModuleId(),
    orchestrators: listTalkOrchestrators(),
    selectedOrchestratorId: selectedTalkOrchestrator(),
    /** Speech path for the next Talk session: Azure gpt-live (default) or Deepgram. */
    voicePaths: listVoicePaths(),
    selectedVoicePathId: selectedVoicePath(),
    /** Whether the decision tree runs before each reply on both Azure paths, gpt-live-1 and Voice Live (off: the model answers by itself). The name is from when it was Voice Live's only. */
    voiceLiveDecisionTree: voiceLiveDecisionTreeOn(),
    /** How Azure Voice Live runs the conversation: "step_by_step" (the five-step flow shared with the Pipecat engine, the default) or "one_prompt". The decision tree, when switched on, wins. */
    voiceLiveFlow: voiceLiveFlowChoice(),
    /** Which configured destination transfer_to_human rings on a Talk call. */
    transferRing: transferRingChoice(),
    /** Model output dropped after a barge-in, Direct Azure and Pipecat alike; applies to the next Talk session. */
    staleOutputDrops: listStaleOutputDrops(),
    selectedStaleOutputDropId: selectedStaleOutputDrop(),
    decisionTrees: listLiveDecisionTrees(),
    selectedDecisionTreeId: selectedDecisionTreeId(),
    decisionModules: listDecisionModuleOptions(),
    decisionModuleStatus: decisionModuleStatus(),
    /** Whether Azure works; when not, new calls are refused. Never carries a key or a host. */
    azureStatus: azureStatus(),
    /** Where run records go and whether write-back is on, by name only: never a host or a password. */
    runStore: describeRunStore(),
    /** Recent voice errors, newest last (up to 20), including ones outside any call. Fixed text only: never a key or a host. */
    voiceErrors: recentVoiceErrors(),
    agencies: [...agencies].map((id) => ({ id, aiCallingEnabled: isAiCallingEnabled(id) })),
    scenarios: listScenarios(),
    leadStoreKind: cfg.leadStoreKind,
    legalBlocks: cfg.legalBlocks,
    testSessionId: cfg.testSessionId,
    /** Whether one real test number is allowlisted. The number itself is never served. */
    testPhoneConfigured: cfg.testPhone !== undefined,
    promptSetupId: cfg.promptSetupId,
    /** The prompt setups a call can start with, and the one selected for the next call. */
    promptSetups: getPromptSetupRegistry().list().map((s) => ({ id: s.id, label: s.label, shipped: s.shipped })),
    selectedPromptSetupId: getPromptSetupRegistry().selectedId(),
  };
}

/**
 * The local development server runs in test mode: legal blocks suspended (each skipped
 * gate shows in the trace), reaching only a browser, a simulated line, or the one
 * allowlisted test number. VOICE_HARNESS_LEGAL_BLOCKS=enforced starts it with the blocks on.
 */
export function startLocalTestMode(env: Record<string, string | undefined> = process.env): void {
  setOpeningIdentity(env.VOICE_HARNESS_OPENING_IDENTITY === "lead_record" ? undefined : DEMO_OPENING);
  setComplianceChecksOff(env.VOICE_HARNESS_COMPLIANCE_CHECKS === "off");
  setActionJudgeOff(env.VOICE_HARNESS_ACTION_JUDGE === "off");
  if (env.VOICE_HARNESS_LEGAL_BLOCKS === "enforced") return setLegalBlocks("enforced");
  setLegalBlocks("suspended");
  setTestPhone(/^\+155501\d{2}$/.test(env.VOICE_HARNESS_TEST_PHONE ?? "") ? env.VOICE_HARNESS_TEST_PHONE : undefined);
  setTestSessionId(`s${Date.now().toString(36)}`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

export { isLoopbackRequest };

/** One server-sent event frame: the raw event for the developer pane and its plain sentence for the agent pane. */
function frame(event: TraceEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify({ event, plain: narrate(event) })}\n\n`;
}

/** Replays recent events, then streams new ones until the page disconnects. */
function streamEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  for (const event of traceBus.history()) res.write(frame(event));
  const unsubscribe = traceBus.subscribe((event) => res.write(frame(event)));
  req.on("close", unsubscribe);
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await handlePromptRoute(req, res)) return;
  if (!isLoopbackRequest(req)) return send(res, 403, { error: "forbidden_non_loopback_request" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  // The local Pipecat engine, reached only through this server (bodies and the live feed stream through).
  if (handlePipecatProxy(req, res)) return;
  try {
    if (req.method === "GET" && path === "/") {
      if (!existsSync(join(webDist, "index.html"))) return send(res, 503, { error: "web_not_built", fix: "Run pnpm build:web" });
      return send(res, 200, readFileSync(join(webDist, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && /^\/assets\/[\w.-]+$/.test(path)) {
      const file = join(webDist, path);
      const type = webTypes[path.slice(path.lastIndexOf("."))];
      if (type && existsSync(file)) return send(res, 200, readFileSync(file, "utf8"), type);
    }
    if (req.method === "GET" && path === "/live-view-core.js") {
      return send(res, 200, readFileSync(coreScriptPath, "utf8"), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && path === "/simulator") {
      return send(res, 200, readFileSync(simulatorPagePath, "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path === "/voice") {
      return send(res, 200, readFileSync(voicePagePath, "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path === "/voice-client.js") {
      return send(res, 200, readFileSync(voiceClientPath, "utf8"), "text/javascript; charset=utf-8");
    }
    const mock = mockFiles[path];
    if (req.method === "GET" && mock) return send(res, 200, readFileSync(join(mockDir, mock.file), "utf8"), mock.type);
    if (req.method === "GET" && serveStaticApp(path, res)) return;
    if (req.method === "GET" && path === "/api/state") return send(res, 200, state());
    if (req.method === "GET" && path === "/api/live-test") return send(res, 200, liveTestSnapshot());
    if (req.method === "GET" && path === "/api/tree") return send(res, 200, currentDecisionTree());
    // Read the mock leads and the harness call records.
    // Before the call routes: /api/calls/ratings is not a call id.
    if (await handleRatingRoute(req.method ?? "GET", path, req, res)) return;
    // The page's rows for a Pipecat call, onto the trace bus for the objectives judge, the scorer and the records (src/server/pipecat-trace-route.ts).
    if (await handlePipecatTraceRoute(req.method ?? "GET", path, req, res)) return;
    if (await handleLeadsRoute(req.method ?? "GET", path, url, res)) return;
    if (await handleCallsRoute(req.method ?? "GET", path, url, res)) return;
    if (req.method === "POST" && path === "/api/call/warmup") {
      // Go in the call setup dialog: check and warm everything the call needs. Always 200; the steps say what failed.
      const { leadId } = await readJson(req);
      // The demo leads exist only once seeded, as /api/play/start does; without this the first warm-up after a restart finds none.
      ensurePlayLeads();
      const result = await warmUpCall({ leadId });
      console.log(warmupLogLine(result));
      return send(res, 200, result);
    }
    if (path.startsWith("/api/play/") && (await playRoute(req.method ?? "GET", path, req, res))) return;
    if (await handleLeadContextRoute(req.method ?? "GET", path, req, res)) return;
    // The dialog's context preview builds the lead block for the call bar's lead, so the demo leads are seeded first, as Go does.
    if (path === "/api/setups/agent-context") ensurePlayLeads();
    // The person's own rating of a call, from the console's pop-up after the call.
    if (await handleSetupRoute(req.method ?? "GET", path, req, res)) return;
    if (await handleFlowEditorRoute(req.method ?? "GET", path, req, res)) return;
    if (req.method === "GET" && path === "/api/events") return streamEvents(req, res);
    if (req.method === "GET" && path === "/api/records") {
      return send(res, 200, recordStore.list().map(({ events, transcript, texts, ...summary }) => ({
        ...summary,
        eventCount: events.length,
      })));
    }
    const recordMatch = path.match(/^\/api\/records\/([\w-]+)$/);
    if (req.method === "GET" && recordMatch) {
      const record = recordStore.read(recordMatch[1]!);
      return record ? send(res, 200, record) : send(res, 404, { error: "record_not_found" });
    }
    const timelineMatch = path.match(/^\/api\/leads\/([\w-]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) return send(res, 200, recordStore.timeline(timelineMatch[1]!));

    const registry = getModuleRegistry();
    const moduleMatch = path.match(/^\/api\/modules\/([\w-]+)$/);
    if (req.method === "POST" && moduleMatch) {
      const { enabled, voice, model, latency, source } = await readJson(req);
      const before = registry.get(moduleMatch[1]!).getConfig();
      registry.update(moduleMatch[1]!, { enabled, voice, model, latency });
      logModuleChanges(moduleMatch[1]!, before, registry.get(moduleMatch[1]!).getConfig(), settingSource(source));
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/select") {
      registry.select((await readJson(req)).moduleId);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/voice/stale-output-drop") {
      const { staleOutputDropId } = await readJson(req);
      selectStaleOutputDrop(staleOutputDropId as StaleOutputDropId);
      return send(res, 200, state());
    }
    if (req.method === "GET" && path === "/api/voice/options") {
      return send(res, 200, await buildVoiceOptions());
    }
    if (req.method === "POST" && path === "/api/voice/path-models") {
      return send(res, 200, await choosePathModel(await readJson(req)));
    }
    if (req.method === "POST" && path === "/api/voice/decision-router") {
      // A refused router changes nothing: 409 with the code and the options as they are.
      const choice = await chooseDecisionRouter(await readJson(req));
      if (!choice.ok) {
        reportVoiceError(choice.error);
        return send(res, 409, { error: choice.error, ...choice.options });
      }
      return send(res, 200, choice.options);
    }
    // Both Azure paths (gpt-live-1 and Voice Live); the earlier Voice Live route name still works.
    if (req.method === "POST" && (path === "/api/voice/decision-tree" || path === "/api/voice/voice-live-decision-tree")) {
      const { enabled } = await readJson(req);
      if (typeof enabled !== "boolean") throw new Error("bad_voice_live_decision_tree");
      setVoiceLiveDecisionTree(enabled);
      console.log(`azure decision tree ${enabled ? "on" : "off"}`);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/voice/voice-live-flow") {
      const { flow } = await readJson(req);
      if (flow !== "step_by_step" && flow !== "one_prompt") throw new Error("bad_voice_live_flow");
      setVoiceLiveFlow(flow);
      console.log(`voice live flow ${flow}`);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/voice/transfer-ring") {
      const { ring } = await readJson(req);
      console.log(`transfer ring ${setTransferRing(ring)}`);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/voice/path") {
      const { voicePathId } = await readJson(req);
      selectVoicePath(voicePathId as VoicePathId);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/orchestration/select") {
      const { orchestratorId } = await readJson(req);
      selectTalkOrchestrator(orchestratorId as TalkOrchestratorId);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/decision-tree/select") {
      const { decisionTreeId } = await readJson(req);
      selectDecisionTree(decisionTreeId as string);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/prompt-setup/select") {
      // The prompt setup the next call starts with; an unknown id changes nothing.
      const { promptSetupId } = await readJson(req);
      if (typeof promptSetupId !== "string" || !promptSetupId) throw new Error("bad_prompt_setup_request");
      try {
        selectPromptSetup(promptSetupId);
      } catch (err) {
        return send(res, 409, { error: err instanceof Error ? err.message : "setup_unknown", ...state() });
      }
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/decision-module/select") {
      // Not /api/select: that one picks the voice module. A refused choice (unknown, or a real model with no credential) changes nothing.
      const { decisionModuleId } = await readJson(req);
      if (typeof decisionModuleId !== "string" || !decisionModuleId) throw new Error("bad_decision_module_request");
      if (TEST_ONLY_DECISION_MODULE_IDS.includes(decisionModuleId)) return send(res, 409, { error: "test_only_decision_module", ...state() });
      const choice = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: decisionModuleId } });
      if (choice.outcome === "refused") return send(res, 409, { error: choice.reason, ...state() });
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/flag") {
      const { agencyId, enabled } = await readJson(req);
      if (typeof agencyId !== "string" || typeof enabled !== "boolean") throw new Error("bad_flag_request");
      setAiCallingEnabled(agencyId, enabled);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/test-session") {
      // A fresh session: duplicate-call keys and the two-attempt counter start clean for the same lead.
      setTestSessionId(`s${Date.now().toString(36)}`);
      return send(res, 200, state());
    }
    if (req.method === "POST" && path === "/api/live-test/path") {
      const { path: livePath } = await readJson(req);
      if (livePath !== "vapi" && livePath !== "azure") throw new Error("bad_live_test_path");
      setLiveTestPath(livePath as LiveTestPath);
      return send(res, 200, liveTestSnapshot());
    }
    if (req.method === "POST" && path === "/api/live-test/azure-model") {
      const { deployment, source } = await readJson(req);
      if (typeof deployment !== "string") throw new Error("bad_deployment");
      setAzureLiveDeployment(deployment, settingSource(source ?? "live-test"));
      return send(res, 200, liveTestSnapshot());
    }
    // Vapi test call: only ever dials the allowlisted test phone from the dev env file, never a lead.
    if (req.method === "POST" && path === "/api/live-test/vapi/call") {
      const { leadId } = await readJson(req);
      if (typeof leadId !== "string" || !/^[\w-]{1,60}$/.test(leadId)) throw new Error("bad_lead_id");
      const lead = (await listPlayLeads()).find((l) => l.id === leadId);
      const firstName = lead?.label.split(" ")[0] ?? "there";
      const result = await startVapiTestCall(firstName);
      return send(res, 200, { ...result, liveTestPath: getLiveTestPath(), liveTest: liveTestSnapshot() });
    }
    const scenarioMatch = path.match(/^\/api\/scenarios\/([\w-]+)\/run$/);
    if (req.method === "POST" && scenarioMatch) {
      return send(res, 200, await runScenario(scenarioMatch[1]!));
    }
    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4310);
  setAiCallingEnabled(getHarnessConfig().agencyId, true);
  startLocalTestMode();
  // Refuse to start without working Azure settings: warn, then exit before listening.
  if (!(await azureStartupGate())) process.exit(1);
  watchAzureFailures(() => void endCallsForAzure());
  // List the Azure deployments once now so the model menu is right before the first call; never throws.
  void loadAzureCatalog();
  installLiveJudge();
  ensureCustomSetupsLoaded();
  // Background only: the console's objectives pane; never on the reply path.
  installObjectivesJudge();
  // Once per call, after it ends: the score the bottom panel shows.
  installPostCallScorer();
  // transfer_to_human can ring the configured test destinations. Tests never arm it.
  const transferLine = armHumanTransfer();
  console.log(`Transfer to a person: armed, listener 127.0.0.1:${transferLine.listenerPort} (started at the first transfer)${dialingIsDryRun() ? ", dry run: calls are built and logged, nothing is dialled" : ""}`);
  const promptChoice = selectPromptSetupFromEnv();
  console.log(promptChoice.refused ? `Prompt setup ${promptChoice.requested} refused (${promptChoice.refused}); ${promptChoice.selected} stays selected` : `Prompt setup: ${promptChoice.selected}${promptChoice.requested ? ` (${PROMPT_SETUP_ENV})` : ""}`);
  console.log(`Legal blocks: ${getHarnessConfig().legalBlocks}`);
  console.log(runStoreLogLine());
  // Loopback only: this page can flip the calling flag.
  const server = createServer((req, res) => void handle(req, res));
  attachVoice(server);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Control page: http://127.0.0.1:${port}  Voice page: http://127.0.0.1:${port}/voice`);
  });
}
