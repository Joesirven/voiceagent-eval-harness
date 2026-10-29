import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAzureError } from "../../src/modules/azure-live-session.js";
import { azureStatus, describeAzureFailure, resetAzureHealth } from "../../src/server/azure-startup-check.js";
import { azureHandshakeCode, realSocketFactory } from "../../src/server/voice/manager.js";
import {
  RECENT_VOICE_ERRORS_LIMIT,
  VOICE_ERROR_CATALOG,
  isVoiceErrorCode,
  normalizeVoiceErrorCode,
  recentVoiceErrors,
  reportVoiceError,
  resetVoiceErrors,
  voiceErrorFrame,
} from "../../src/server/voice/voice-errors.js";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";

beforeEach(() => {
  resetVoiceErrors();
  resetAzureHealth();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  resetAzureHealth();
  vi.restoreAllMocks();
});

const entries = Object.entries(VOICE_ERROR_CATALOG);
const ALLOWED_CAPITALS = new Set(["URL", "HTTP", "JSON", "API", "SSH", "SQL"]);

describe("the voice error catalog", () => {
  it.each(entries)("%s has a title, what happened and a concrete fix", (_code, e) => {
    expect(e.title.length).toBeGreaterThan(5);
    expect(e.what.length).toBeGreaterThan(15);
    expect(e.fix.length).toBeGreaterThan(15);
    expect(["error", "warning"]).toContain(e.severity);
    expect(typeof e.canContinue).toBe("boolean");
    // A fix is an instruction, not a restatement.
    expect(e.fix).toMatch(/[.]$/);
  });

  it("keeps the no-acronym rule: capitals only for allowed names or literal identifiers", () => {
    for (const [code, e] of entries) {
      for (const text of [e.title, e.what, e.fix]) {
        for (const token of text.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []) {
          if (token.includes("_") || ALLOWED_CAPITALS.has(token)) continue;
          throw new Error(`${code}: unexplained acronym "${token}" in: ${text}`);
        }
        expect(text, code).not.toMatch(/ — .* — /);
      }
    }
  });

  it("never carries a hostname, a key value or provider text", () => {
    for (const e of Object.values(VOICE_ERROR_CATALOG)) {
      for (const text of [e.title, e.what, e.fix]) {
        expect(text).not.toMatch(/azure\.com|cognitiveservices|openai\.azure|deepgram\.com|sk-[a-z0-9]|Bearer/i);
      }
    }
  });

  it("every Azure-not-working code maps to a code the Azure status can describe", () => {
    const blocking = entries.filter(([, e]) => "azureBlock" in e && e.azureBlock);
    expect(blocking.map(([c]) => c)).toEqual(expect.arrayContaining(["azure_auth_failed", "azure_deployment_not_found", "azure_settings_missing_key"]));
    for (const [, e] of blocking) expect(describeAzureFailure((e as { azureBlock: string }).azureBlock)).not.toMatch(/^check failed/);
  });

  it("the error table in docs/live-voice.md lists every code", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../docs/live-voice.md", import.meta.url)), "utf8");
    for (const [code] of entries) expect(doc, code).toContain(`| \`${code}\` |`);
  });

  it("covers every fixed code the voice files and sidecars can produce", () => {
    const here = fileURLToPath(new URL("../../src/server/voice/", import.meta.url));
    const sidecars = fileURLToPath(new URL("../../src/orchestration-modules/pipecat/", import.meta.url));
    const found = new Set<string>();
    // Host side: codes thrown or reported as literals.
    for (const f of readdirSync(here).filter((n) => n.endsWith(".ts") && !["voice-errors.ts", "test-phone.ts", "vapi-test-call.ts"].includes(n))) {
      const src = readFileSync(join(here, f), "utf8");
      for (const m of src.matchAll(/(?:new Error|reportVoiceError|onProviderError\??\.|this\.fail|failed)\(\s*"([a-z][a-z0-9_]+)"/g)) found.add(m[1]!);
    }
    // Sidecars: codes passed to fail(...) or returned by the classifier.
    for (const f of readdirSync(sidecars).filter((n) => n.endsWith(".py"))) {
      const src = readFileSync(join(sidecars, f), "utf8");
      for (const m of src.matchAll(/fail\("([a-z_]+)"\)/g)) found.add(m[1]!);
      for (const m of src.matchAll(/return "((?:azure|deepgram)_[a-z_]+)"/g)) found.add(m[1]!);
      for (const m of src.matchAll(/ if azure else "([a-z_]+)"|"([a-z_]+)" if azure else/g)) found.add((m[1] ?? m[2])!);
    }
    // Codes that are session control, not errors, or only a thrown shape check.
    const notErrors = new Set(["voice_session_ended"]);
    const missing = [...found].filter((c) => !notErrors.has(c) && !isVoiceErrorCode(c) && normalizeVoiceErrorCode(c) === "voice_unknown_error");
    expect(missing).toEqual([]);
    expect(found.size).toBeGreaterThan(10);
  });
});

describe("emission", () => {
  it("keeps a recent list with fixed text, newest last, capped, also outside any call", () => {
    const first = reportVoiceError("deepgram_key_missing");
    expect(first).toMatchObject({
      id: 1,
      code: "deepgram_key_missing",
      severity: "error",
      canContinue: false,
      blocksNewCalls: false,
      path: "deepgram",
    });
    expect(first.callId).toBeUndefined();
    expect(first.fix).toContain("DEEPGRAM_API_KEY");
    for (let i = 0; i < RECENT_VOICE_ERRORS_LIMIT + 5; i++) reportVoiceError("text_not_sent");
    const list = recentVoiceErrors();
    expect(list).toHaveLength(RECENT_VOICE_ERRORS_LIMIT);
    expect(list.at(-1)!.id).toBeGreaterThan(list[0]!.id);
    expect(list.some((r) => r.id === 1)).toBe(false);
  });

  it("never passes a raw message through: unknown codes become one generic entry", () => {
    const r = reportVoiceError("secret-key-abc123 at host.example");
    expect(r.code).toBe("voice_unknown_error");
    expect(JSON.stringify(r)).not.toContain("abc123");
    expect(normalizeVoiceErrorCode("deepgram_error")).toBe("deepgram_failed");
  });

  it("emits a voice_error trace event on a traced call, without the call id inside data", () => {
    traceBus.reset();
    const events: TraceEvent[] = [];
    const stop = traceBus.subscribe((e) => void events.push(e));
    const trace = { leadId: "lead-1", leadLabel: "Jane", recordId: "call-x", channel: "call" as const, direction: "inbound" as const, callId: "call-x" };
    const r = reportVoiceError("pipecat_failed", { trace });
    reportVoiceError("pipecat_failed"); // no trace context: list only
    stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "voice_error", callId: "call-x", recordId: "call-x" });
    expect(events[0]!.data).toMatchObject({ code: "pipecat_failed", title: r.title, detail: r.detail, fix: r.fix, severity: "error", canContinue: false, id: r.id });
    expect(events[0]!.data).not.toHaveProperty("callId");
    expect(r.callId).toBe("call-x");
  });

  it("a plain restart fix names an alternative that fits the path the call is on", () => {
    expect(reportVoiceError("azure_error", { path: "azure_gpt_live" }).fix).not.toMatch(/Direct Azure|Voice path/);
    expect(reportVoiceError("protocol_error", { path: "pipecat" }).fix).toContain("Orchestrator to Direct Azure");
    expect(reportVoiceError("protocol_error", { path: "deepgram" }).fix).toContain("Voice path to Azure gpt-live");
    expect(reportVoiceError("protocol_error", { path: "deepgram" }).fix).not.toContain("Direct Azure");
  });

  it("a retry is a warning that says it is trying once more", () => {
    const r = reportVoiceError("azure_connect_failed", { retrying: true });
    expect(r).toMatchObject({ severity: "warning", canContinue: true });
    expect(r.detail).toContain("trying once more");
  });

  it("the socket frame carries the code and every record field", () => {
    const frame = voiceErrorFrame(reportVoiceError("microphone_audio_missing", { callId: "c1" }));
    expect(frame).toMatchObject({ type: "error", code: "microphone_audio_missing", severity: "warning", canContinue: true, callId: "c1" });
    expect(frame.fix).toBeTruthy();
  });

  it("only Azure-not-working codes mark Azure as failed, and the status carries the Azure code, not the voice code", async () => {
    reportVoiceError("pipecat_failed");
    reportVoiceError("deepgram_key_rejected");
    reportVoiceError("azure_rate_limited");
    reportVoiceError("azure_start_timeout");
    expect(azureStatus().ok).toBe(true);
    const r = reportVoiceError("azure_auth_failed");
    expect(r.blocksNewCalls).toBe(true);
    await Promise.resolve(); // the block is applied right after the caller has told the page
    expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_auth", source: "runtime" });
    resetAzureHealth();
    reportVoiceError("azure_deployment_not_found");
    await Promise.resolve();
    expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_deployment_not_found" });
    resetAzureHealth();
    reportVoiceError("azure_settings_missing_key");
    await Promise.resolve();
    expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_missing_AZURE_FOUNDRY_KEY" });
  });
});

describe("Azure classification", () => {
  it("reads in-session error events by code, type and status, never by message text", () => {
    expect(classifyAzureError({ code: "invalid_api_key" })).toBe("azure_auth_failed");
    expect(classifyAzureError({ type: "authentication_error" })).toBe("azure_auth_failed");
    expect(classifyAzureError({ status: 401 })).toBe("azure_auth_failed");
    expect(classifyAzureError({ code: "DeploymentNotFound" })).toBe("azure_deployment_not_found");
    expect(classifyAzureError({ type: "invalid_request_error", code: "model_not_deployed" })).toBe("azure_model_not_deployed");
    expect(classifyAzureError({ type: "server_error", code: "output_creation_failed" })).toBe("azure_error"); // reported as azure_session_rejected before start
    expect(classifyAzureError({ code: "rate_limit_exceeded" })).toBe("azure_rate_limited");
    expect(classifyAzureError({ message: "401 unauthorized" })).toBe("azure_error");
    expect(classifyAzureError("boom")).toBe("azure_error");
    expect(classifyAzureError(undefined)).toBe("azure_error");
  });

  it("maps the websocket handshake status to a code", () => {
    expect(azureHandshakeCode(401)).toBe("azure_auth_failed");
    expect(azureHandshakeCode(403)).toBe("azure_auth_failed");
    expect(azureHandshakeCode(404)).toBe("azure_deployment_not_found");
    expect(azureHandshakeCode(429)).toBe("azure_rate_limited");
    expect(azureHandshakeCode(500)).toBe("azure_connect_failed");
    expect(azureHandshakeCode(undefined)).toBe("azure_connect_failed");
  });

  describe("the real socket factory", () => {
    let server: Server;
    afterEach(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    const answering = async (status: number) => {
      server = createServer((_req, res) => void res.writeHead(status).end("provider text that must not surface"));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/live`;
    };

    it.each([
      [401, "azure_auth_failed"],
      [404, "azure_deployment_not_found"],
      [429, "azure_rate_limited"],
      [500, "azure_connect_failed"],
    ])("a %i handshake answer rejects with %s only", async (status, code) => {
      const url = await answering(status);
      await expect(realSocketFactory(url, "key-value")).rejects.toThrow(new RegExp(`^${code}$`));
    });

    it("a refused connection is azure_connect_failed", async () => {
      await expect(realSocketFactory("ws://127.0.0.1:1/live", "key-value")).rejects.toThrow(/^azure_connect_failed$/);
      server = createServer();
    });
  });

  it("speaks of live deployments, the model kind the live protocol takes, never realtime deployments", () => {
    expect(VOICE_ERROR_CATALOG.azure_session_rejected.fix).toContain("live deployment");
    expect(JSON.stringify(VOICE_ERROR_CATALOG)).not.toContain("realtime deployment");
  });
});
