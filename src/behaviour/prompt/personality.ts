/**
 * Personality profiles as data (data/personalities.json), plus a non-blocking style
 * lint. The lint is separate from the enforcement findings: it never blocks a line.
 */

import { readDataFile } from "../data-files.js";

export interface PersonalityProfile {
  id: string;
  label: string;
  summary: string;
  /** Instructions on how to sound. */
  tone: string[];
  tempo: {
    maxSentencesPerTurn: number;
    targetWordsPerTurn: number;
    maxWordsPerTurn: number;
    pauseAfterQuestion: string;
    matchCallerPace: boolean;
    rushedCallerRule: string;
  };
  vocabulary: {
    prefer: { say: string; insteadOf?: string[] }[];
    avoid: { term: string; say?: string }[];
  };
  avoidFillers: string[];
  rapport: string[];
  /** Playbook item identifiers the profile was derived from; checked by a test, never rendered. */
  derivedFrom?: string[];
}

export const DEFAULT_PERSONALITY_ID = "steady-professional";

let cache: readonly PersonalityProfile[] | undefined;

export function listPersonalities(): readonly PersonalityProfile[] {
  cache ??= readDataFile<{ profiles: PersonalityProfile[] }>("personalities.json").profiles;
  return cache;
}

export function findPersonality(id: string): PersonalityProfile | undefined {
  return listPersonalities().find((p) => p.id === id);
}

export function getPersonality(id: string): PersonalityProfile {
  const profile = findPersonality(id);
  if (!profile) throw new Error(`personality_unknown:${id}`);
  return profile;
}

export interface StyleFinding {
  rule: string;
  excerpt: string;
  note: string;
}

const BUILT_IN_FILLERS = ["trust me", "to be honest", "i'm not going to lie", "i am not going to lie", "believe me", "to tell you the truth"];
const STILL_THERE = /\b(?:are you|you) still (?:there|with me|on the line)\b/i;
const FORMAL_ADDRESS = /\b(?:sir|ma'am|madam)\b/i;
const APOLOGY = /\b(?:sorry|apologi[sz]e|apologies|pardon me)\b/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`, "i");
}

function countSentences(text: string): number {
  const matches = text.trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  return matches ? matches.filter((m) => /\w/.test(m)).length : 0;
}

function around(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 20), index + length + 20).trim();
}

/** A non-blocking style check of one agent turn against a profile. */
export function lintStyle(text: string, profile: PersonalityProfile): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const lower = text.toLowerCase();

  const fillers = new Set([...BUILT_IN_FILLERS, ...profile.avoidFillers.map((f) => f.toLowerCase())]);
  for (const filler of fillers) {
    if (/still there/.test(filler)) continue;
    const found = wordPattern(filler).exec(lower);
    if (found) {
      findings.push({
        rule: "credibility_filler",
        excerpt: text.slice(found.index, found.index + filler.length),
        note: "Credibility fillers make the caller doubt everything else. Say the plain fact.",
      });
    }
  }

  const still = STILL_THERE.exec(text);
  if (still) {
    findings.push({
      rule: "are_you_still_there",
      excerpt: still[0],
      note: "Do not ask whether the caller is still there. Cover a lookup truthfully or ask a forward question.",
    });
  }

  const formal = FORMAL_ADDRESS.exec(text);
  if (formal) {
    findings.push({
      rule: "formal_address",
      excerpt: around(text, formal.index, formal[0].length),
      note: "Use the caller's first name, not sir or ma'am.",
    });
  }

  for (const entry of profile.vocabulary.avoid) {
    const found = wordPattern(entry.term).exec(text);
    if (found) {
      findings.push({
        rule: "avoided_vocabulary",
        excerpt: found[0],
        note: entry.say ? `Say "${entry.say}" instead of "${entry.term}".` : `Do not use the word "${entry.term}"; use the caller's own words.`,
      });
    }
  }

  const questionMarks = [...text.matchAll(/\?/g)];
  if (questionMarks.length > 1) {
    const second = questionMarks[1].index ?? 0;
    findings.push({
      rule: "multiple_questions",
      excerpt: around(text, second, 1),
      note: `${questionMarks.length} questions in one turn. Ask one question at a time.`,
    });
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > profile.tempo.maxWordsPerTurn) {
    findings.push({
      rule: "turn_too_long",
      excerpt: text.trim().slice(0, 60),
      note: `${words} words; ${profile.label} keeps turns to ${profile.tempo.maxWordsPerTurn} words at most.`,
    });
  }

  const sentences = countSentences(text);
  if (sentences > profile.tempo.maxSentencesPerTurn) {
    findings.push({
      rule: "too_many_sentences",
      excerpt: text.trim().slice(0, 60),
      note: `${sentences} sentences; ${profile.label} keeps turns to ${profile.tempo.maxSentencesPerTurn} at most.`,
    });
  }

  const apologies = [...text.matchAll(APOLOGY)];
  if (apologies.length > 1) {
    findings.push({
      rule: "multiple_apologies",
      excerpt: around(text, apologies[1].index ?? 0, apologies[1][0].length),
      note: "More than one apology in a turn. After a slip, move to the next question.",
    });
  }

  return findings;
}
