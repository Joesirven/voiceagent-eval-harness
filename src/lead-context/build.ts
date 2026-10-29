/**
 * Builds the lead context block. Pure: the clock is an input. The block is
 * information for the agent, never lines to recite: live words always.
 */

import { createHash } from "node:crypto";
import type { OpeningIdentity } from "../config.js";
import { buildChecklist, checklistLine } from "./checklist.js";
import { buildFacts } from "./facts.js";
import { computeRenewal } from "./renewal.js";
import { stageInfo } from "./stage.js";
import {
  SOURCE_AGENCY_CALL_SETUP,
  SOURCE_NO_AGENCY,
  SOURCE_NO_PRODUCER,
  SOURCE_NOT_ON_FILE,
  SOURCE_PRODUCER_HOLDING,
  type LeadContextInput,
  type LeadContextJson,
  type LeadContextOutput,
  type OpeningName,
} from "./types.js";

const INTRO = "Lead context. This is information for you, not lines to recite: use your own live words always.";

export const CONFIRMATION_GATE =
  "Do not mention or reveal the account, the business, or the renewal date until the named person is confirmed on this call.";

/** Follows the earlier call summaries whenever any are on file. */
export const EARLIER_NOTES_FIGURES =
  "Figures in these notes are for you only: never read a figure out, and never ask the caller to confirm one.";

/** Where the names come from when the harness's opening identity names them. */
export const SOURCE_OPENING_IDENTITY = "the harness's opening identity, which names this producer and agency for every lead, as the opening line does";

/** The lead context input, plus the harness's opening identity (src/config.ts) when one is set. */
export type LeadContextBuildInput = LeadContextInput & {
  /** When set, it names the producer and the agency for every lead, whatever the record or the call setup says. */
  openingIdentity?: OpeningIdentity;
};

function openingName(value: string | undefined, source: string, missingSource: string): OpeningName {
  const v = value?.trim();
  return v ? { value: v, source, held: false } : { value: "unknown", source: missingSource, held: false };
}

/**
 * The confirmation gate, on unless VOICE_HARNESS_LEAD_CONTEXT_GATE=off (for the demo). Read on
 * every build, so the setting applies from the next block or update. With the gate off every block and update
 * carries the known values, the missing quote fields and the renewal days, whether or not the named person
 * is confirmed.
 */
export function leadContextGateOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VOICE_HARNESS_LEAD_CONTEXT_GATE ?? "").trim().toLowerCase() !== "off";
}

export function buildLeadContextJson(input: LeadContextBuildInput): LeadContextJson {
  const confirmed = (input.confirmed ?? false) || !leadContextGateOn();
  const held = !confirmed;
  const identity = input.openingIdentity;
  return {
    leadId: input.packet.leadId,
    direction: input.direction,
    confirmed,
    producerName: identity
      ? openingName(identity.producerFirstName, SOURCE_OPENING_IDENTITY, SOURCE_NO_PRODUCER)
      : openingName(input.packet.briefing?.producerName, SOURCE_PRODUCER_HOLDING, SOURCE_NO_PRODUCER),
    agencyName: identity
      ? openingName(identity.agencyName, SOURCE_OPENING_IDENTITY, SOURCE_NO_AGENCY)
      : openingName(input.agencyName, SOURCE_AGENCY_CALL_SETUP, SOURCE_NO_AGENCY),
    facts: buildFacts(input.packet, confirmed),
    stage: stageInfo(input.flowStep),
    checklist: buildChecklist(input.packet, held),
    renewal: computeRenewal(input.packet, input.now, held),
  };
}

function openingLines(json: LeadContextJson): string[] {
  return [
    `Producer whose assistant you are: ${json.producerName.value} (source: ${json.producerName.source}).`,
    `Agency name: ${json.agencyName.value} (source: ${json.agencyName.source}).`,
  ];
}

function stageLines(json: LeadContextJson): string[] {
  return [`Call direction: ${json.direction}.`, `Call stage: ${json.stage.flowStep}. ${json.stage.meaning}`];
}

/** Stage, quote checklist and days to renewal: the part that changes during a call. */
export function renderUpdateText(json: LeadContextJson): string {
  return [
    ...stageLines(json),
    "What a quote needs (confirm record values with the caller; only the caller's own words count):",
    ...json.checklist.map(checklistLine),
    json.renewal.sentence,
  ].join("\n");
}

/** A short hash of the update text; equal fingerprints mean nothing worth re-sending changed. */
export function updateFingerprint(json: LeadContextJson): string {
  return createHash("sha256").update(renderUpdateText(json)).digest("hex").slice(0, 16);
}

/** What the agent must get from the person on this call: the still-needed quote fields, then the text agreement. */
function needsLine(json: LeadContextJson): string {
  const needed = json.checklist.filter((r) => r.status === "still_needed").map((r) => r.label);
  const first = needed.length ? needed.join("; ") : "confirm what is on file";
  return `What this call needs from them: ${first}, then their yes to receiving the quote by text.`;
}

export function renderFullText(json: LeadContextJson): string {
  // The earlier call summaries are printed here only (not in the standing rules or the rest of the lead block).
  const facts = json.facts.map((f) => {
    const row = `- ${f.label}: ${f.value} (source: ${f.source})`;
    return f.key === "earlier_calls" && f.source !== SOURCE_NOT_ON_FILE ? `${row} ${EARLIER_NOTES_FIGURES}` : row;
  });
  return [INTRO, needsLine(json), ...openingLines(json), "Who is calling (the person may not be who the record names; confirm before relying on any of it):", ...facts, renderUpdateText(json)].join("\n");
}

function renderGatedText(json: LeadContextJson): string {
  const name = json.facts.find((f) => f.key === "name_on_file");
  return [INTRO, `Name on file: ${name?.value ?? "unknown"} (source: ${name?.source ?? "not on file"}). The person on the call is not yet confirmed to be this person.`, ...openingLines(json), ...stageLines(json), CONFIRMATION_GATE].join("\n");
}

/** The block for the agent. Before the named person is confirmed it carries only the name on file and the stage. */
export function buildLeadContext(input: LeadContextBuildInput): LeadContextOutput {
  const json = buildLeadContextJson(input);
  return { json, text: json.confirmed ? renderFullText(json) : renderGatedText(json) };
}
