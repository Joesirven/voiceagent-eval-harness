import { containsAsWords, evidenceSupportsValue } from "./evidence.js";
import type { TranscriptTurn } from "../provider/interface.js";
import type { HandoffNote } from "../store/lead-store.js";

export interface ExtractedFieldCandidate {
  field: string;
  value: string;
  evidenceSpan: string;
}

export function rejectUnsupportedFields(
  candidates: ExtractedFieldCandidate[],
  callerTurns: string[],
): { accepted: ExtractedFieldCandidate[]; rejected: ExtractedFieldCandidate[] } {
  const accepted: ExtractedFieldCandidate[] = [];
  const rejected: ExtractedFieldCandidate[] = [];
  for (const c of candidates) {
    if (evidenceSupportsValue(c.value, c.evidenceSpan, callerTurns)) {
      accepted.push(c);
    } else {
      rejected.push(c);
    }
  }
  return { accepted, rejected };
}

/** Spoken text of one side of the call, joined for whole-word matching. */
function speakerCorpus(transcript: TranscriptTurn[], speaker: "caller" | "agent"): string {
  return transcript
    .filter((t) => t.role === speaker && t.spoken !== false)
    .map((t) => t.text)
    .join(" ");
}

/**
 * A handoff claim is stored only when it is supported by the right side of
 * the call. What the caller wanted must have all its words (whole words) in
 * caller turns. What the agent promised, or left open, must be a contiguous
 * phrase the agent actually spoke.
 */
export function claimSupportedByTranscript(
  transcript: TranscriptTurn[],
  claim: string,
  speaker: "caller" | "agent",
): boolean {
  const line = claim.trim();
  if (!line) return false;
  const corpus = speakerCorpus(transcript, speaker);
  if (containsAsWords(corpus, line)) return true;
  // What the agent promised or left open must be a contiguous phrase it spoke.
  if (speaker === "agent") return false;
  const tokens = line.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (tokens.length === 0) return false;
  return tokens.every((w) => containsAsWords(corpus, w));
}

export function validateHandoffClaims(
  transcript: TranscriptTurn[],
  callerWanted: string,
  promised: string,
  openQuestions: string[],
): { ok: boolean; rejected: string[] } {
  const rejected: string[] = [];
  if (!claimSupportedByTranscript(transcript, callerWanted, "caller")) {
    rejected.push("callerWanted");
  }
  if (!claimSupportedByTranscript(transcript, promised, "agent")) {
    rejected.push("promised");
  }
  for (const q of openQuestions) {
    if (!claimSupportedByTranscript(transcript, q, "agent")) {
      rejected.push(`openQuestion:${q}`);
    }
  }
  return { ok: rejected.length === 0, rejected };
}

export function buildHandoffNote(
  callId: string,
  transcript: TranscriptTurn[],
  callerWanted: string,
  promised: string,
  openQuestions: string[],
  evidenceBackedFields: Record<string, { value: string; evidenceSpan: string }>,
): HandoffNote | null {
  const validation = validateHandoffClaims(transcript, callerWanted, promised, openQuestions);
  if (!validation.ok) {
    return null;
  }
  const bullets = Object.entries(evidenceBackedFields).map(
    ([k, v]) => `Caller said: "${v.evidenceSpan}" (${k}=${v.value})`,
  );
  const narrative = [
    `What caller wanted: ${callerWanted}`,
    `What we promised: ${promised}`,
    openQuestions.length ? `Open: ${openQuestions.join("; ")}` : "",
    bullets.length ? bullets.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    callId,
    createdAt: new Date().toISOString(),
    callerWanted,
    promised,
    openQuestions,
    evidenceBackedFields,
    narrative,
  };
}
