/**
 * Real Vapi outbound test call using the generic example assistant snapshot.
 * Never dials numbers outside the allowlist.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { peekDevEnvValues, readDevEnvFile, type DevEnvFs } from "./dev-env-file.js";
import { assertTestPhoneOnly, loadAllowlistedTestPhone } from "./test-phone.js";

const VAPI_WANTED = ["VAPI_API_KEY", "VAPI_PILOT_PHONE_NUMBER_ID", "VAPI_PILOT_ASSISTANT_ID"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const exampleConfigPath = join(here, "../../../docs/voice-bakeoff/configs/vapi-live-example.json");

export interface VapiWiring {
  ready: boolean;
  missingEnv: string[];
}

export function peekVapiWiring(
  env: Record<string, string | undefined> = process.env,
  fs?: DevEnvFs,
): VapiWiring {
  const missing: string[] = [];
  if (!env.VOICE_HARNESS_DEV_ENV_FILE?.trim()) {
    missing.push("VOICE_HARNESS_DEV_ENV_FILE");
    return { ready: false, missingEnv: missing };
  }
  try {
    readDevEnvFile(env, fs);
  } catch {
    missing.push("VOICE_HARNESS_DEV_ENV_FILE");
    return { ready: false, missingEnv: missing };
  }
  const values = peekDevEnvValues(VAPI_WANTED, env, fs);
  for (const key of VAPI_WANTED) {
    if (!values[key]?.trim()) missing.push(key);
  }
  if (!loadAllowlistedTestPhone(env, fs)) missing.push("VOICE_HARNESS_TEST_PHONE or VOICE_HARNESS_SECONDARY_TEST_PHONE (in dev env file)");
  return { ready: missing.length === 0, missingEnv: missing };
}

export interface VapiCallVariables {
  first_name: string;
  business_name: string;
  producer_name: string;
  agency_name: string;
  current_carrier: string;
  renewal_month: string;
}

export function defaultVapiVariables(firstName: string): VapiCallVariables {
  return {
    first_name: firstName,
    business_name: "Riverside Plumbing",
    producer_name: "Dana Reyes",
    agency_name: "Northwind Insurance Agency",
    current_carrier: "Example Mutual",
    renewal_month: "March",
  };
}

function loadExampleAssistant(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(exampleConfigPath, "utf8")) as { assistant?: Record<string, unknown> };
  if (!raw.assistant || typeof raw.assistant !== "object") throw new Error("vapi_example_config_invalid");
  return raw.assistant;
}

export interface PlaceVapiTestCallInput {
  customerPhone: string;
  variableValues: VapiCallVariables;
  env?: Record<string, string | undefined>;
  fs?: DevEnvFs;
  fetchImpl?: typeof fetch;
}

export interface PlaceVapiTestCallResult {
  callId: string;
  status: string;
}

export async function placeVapiTestCall(input: PlaceVapiTestCallInput): Promise<PlaceVapiTestCallResult> {
  const env = input.env ?? process.env;
  const wiring = peekVapiWiring(env, input.fs);
  if (!wiring.ready) throw new Error(`vapi_setup_blocked:${wiring.missingEnv.join(",")}`);

  const allowlisted = loadAllowlistedTestPhone(env, input.fs)!;
  assertTestPhoneOnly(input.customerPhone, allowlisted);

  readDevEnvFile(env, input.fs);
  const values = peekDevEnvValues(VAPI_WANTED, env, input.fs);
  const apiKey = values.VAPI_API_KEY!;
  const phoneNumberId = values.VAPI_PILOT_PHONE_NUMBER_ID!;
  const assistantId = values.VAPI_PILOT_ASSISTANT_ID!;

  // The snapshot checks the generic assistant shape. The live call uses its configured assistant id plus overrides.
  loadExampleAssistant();
  const fetchFn = input.fetchImpl ?? fetch;
  const response = await fetchFn("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: { number: input.customerPhone },
      assistantOverrides: { variableValues: input.variableValues },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`vapi_call_rejected:${response.status}`);
  const body = (await response.json()) as { id?: unknown; status?: unknown };
  if (typeof body.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(body.id)) throw new Error("vapi_call_invalid_response");
  return { callId: body.id, status: typeof body.status === "string" ? body.status : "unknown" };
}
