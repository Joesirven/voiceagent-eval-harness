/**
 * The structured ask the offline judges, the Fable analysis and the simulated
 * lead use, for those and never on a live call. The reply is JSON that matches
 * `schema`. These names are aliases of the connector types in
 * src/connectors/json-client.ts: every ask goes through the Vercel AI Gateway
 * (or Azure AI Foundry for a bare deployment name), not a direct Anthropic client.
 *
 * The Gateway's own model listing is the authority on model ids. The two ids
 * below follow its "provider/model" form but have not been checked against the
 * listing; check them on the first real run.
 *
 * Fable 5.1 supports no zero data retention on any provider (the Gateway keeps
 * prompts and completions for 30 days and does not train on them), so asks for
 * it set `zeroDataRetention: false`. Real past calls are redacted
 * (`redactText`) before they are put in a prompt.
 *
 * Tests never reach a model: every judge takes an interface, and the mocks fill it.
 */

import type { JsonAsk, JsonModelClient } from "../../connectors/json-client.js";

export const FABLE_MODEL = "anthropic/claude-fable-5-1";
export const OPUS_MODEL = "anthropic/claude-opus-5-5";

export type ClaudeJsonAsk = JsonAsk;
export type ClaudeJsonClient = JsonModelClient;
