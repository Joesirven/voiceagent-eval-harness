/**
 * Assembles the six decision tree fragments into the one tree the harness loads.
 *
 * Usage: tsx scripts/assemble-decision-tree.ts <fragment-directory> [--out file] [--report file]
 *
 * Input:  fragment-open.json, fragment-discovery.json, fragment-objection.json,
 *         fragment-service.json, fragment-close.json, fragment-compliance.json
 *         (read only; lead-scripts.json is caller-only and is never read).
 * Output: src/decision-tree/full-tree.json and docs/full-tree-fit-report.md.
 *
 * The script is deterministic: same fragments in, same bytes out. The output
 * is never edited by hand. Every place where a fragment does not fit the
 * loader's shape pushes a record, and the report is written from those records.
 * Where a fragment cannot fit, the script takes the most conservative minimal
 * mapping and says so; it never changes content to make the validator pass.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEXICON } from "../src/decision/lexicon.js";
import { DURABLE_BAR, MAX_ANSWERS, MIN_BAR, treeProblems } from "../src/decision-tree/index.js";
import type { Area, DecisionTreeData, FlowStep, TreeAnswer, TreeDisposition, TreeNode } from "../src/decision-tree/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fragmentDir = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
if (!fragmentDir) {
  console.error("usage: tsx scripts/assemble-decision-tree.ts <fragment-directory> [--out file] [--report file]");
  process.exit(2);
}
const outFile = flag("--out") ?? join(repo, "src/decision-tree/full-tree.json");
const reportFile = flag("--report") ?? join(repo, "docs/full-tree-fit-report.md");

// ---------------------------------------------------------------- fit records

interface FitRecord {
  fragment: string;
  node: string;
  kind: string;
  problem: string;
  action: string;
  decision: string;
}
const records: FitRecord[] = [];
const fit = (fragment: string, node: string, kind: string, problem: string, action: string, decision = "none, mechanical") =>
  records.push({ fragment, node, kind, problem, action, decision });

// ---------------------------------------------------------------- constants

const FRAGMENTS = ["open", "discovery", "objection", "service", "close", "compliance"] as const;
type FragmentName = (typeof FRAGMENTS)[number];

/** Defaults the fragments do not give. */
const DEFAULT_BAR = 0.7;
const GENERIC_CLARIFY = "Sorry, I did not catch that. Could you say it once more?";
const CLOSING_LINE = "Thank you for your time. Goodbye.";
const FALLBACK_NODE = "close.pre_ask_check";

/** Ids a fragment uses for a node that another fragment names differently. `stated` is true when a fragment says so itself. */
const ALIASES: Record<string, { to: string; stated: boolean }> = {
  "close.offer_appointment": { to: "close.ask_for_appointment", stated: true },
  "close.schedule_callback": { to: "close.callback_schedule", stated: true },
  "discovery.collect_payroll_headcount": { to: "discovery.headcount", stated: true },
  "compliance.opt_out": { to: "compliance.stop_apply", stated: true },
  "compliance.opt_out_requested": { to: "compliance.stop_apply", stated: true },
  "compliance.upset_caller": { to: "compliance.upset_deescalate", stated: true },
  "service.existing_client": { to: "service.identify_need", stated: true },
  "service.route_request": { to: "service.identify_need", stated: true },
  "service.claim_report": { to: "service.claim_or_loss", stated: true },
  // The close fragment calls both ids placeholders for the sibling fragments (its open question 9: "The merge step must reconcile them").
  // The discovery fragment names the target of the first (its asks to the sibling authors, ask 1). Nothing names the target of the second.
  "discovery.next_priority_question": { to: "discovery.choose_next_question", stated: true },
  "objection.route": { to: "objection.classify", stated: false },
};
/** What the close fragment says about its placeholder ids, quoted in the notes. */
const PLACEHOLDER_NOTE = "the close fragment calls it a placeholder to be reconciled (its open question 9)";

/** Nodes the harness owns (the pre-answer checks run in code before the tree). Dropped, not mapped. */
const HARNESS_NODES = ["open.entry", "compliance.entry_gate"];
/** Nodes the interrupt block replaces. */
const REPLACED_BY_INTERRUPTS = ["compliance.interrupt_router"];
/** Nodes decided by a tool result: folded into the answer before them, edges redirected to the node named. */
const FOLDED: Record<string, string> = {
  "close.booking_result": "close.after_booking_prep",
  "close.check_producer_available": "close.offer_live_transfer",
  "compliance.human_availability": "close.offer_live_transfer",
  "close.transfer_in_progress": "close.write_handoff_note",
  "close.send_confirmation_text": "close.write_handoff_note",
};

const TERMINAL_RENAMES: Record<string, string> = {
  appointment_booked: "booked",
  transferred_live: "handed_off",
  transferred_to_human: "handed_off",
};
/** Durable (takes the lead off the list) after mapping. The rule judge accepts a durable ending only for these two. */
const DURABLE_FINAL = new Set(["do_not_contact", "not_interested", "wrong_number", "declined_ai_or_recording"]);
/** Endings that spoke a line from the plan, for the ledger. */
const endingsUsed: string[] = [];

/** Answers that go to these nodes are covered by the tree level interrupt check, so they leave the per node answer lists. */
const INTERRUPT_COVERED_TARGETS = new Set([
  "compliance.emergency_safety",
  "compliance.stop_clarify",
  "compliance.stop_apply",
  "compliance.legal_threat",
  "compliance.upset_deescalate",
  "open.ai_question",
]);
/** Nodes whose own stop and safety answers are the point of the node: never lifted. */
const NEVER_LIFT_FROM = (id: string) => id.startsWith("compliance.") || id === "objection.confirm_stop";

/** Nodes that are routers or state steps rather than objection classes (the validator wants a repeat key on every objection question). */
const OBJECTION_ENTRY_NODES = ["objection.classify", "objection.clarify"];

const CLOSE_TRANSFER = ["close.check_producer_available", "close.offer_live_transfer", "close.transfer_in_progress"];
const CLOSE_MESSAGE = ["close.take_message", "close.confirm_message", "close.write_handoff_note"];

/** Plain-words replacements for the abbreviations the validator rejects. */
const ACRONYM_WORDS: Record<string, string> = {
  GL: "general liability",
  COI: "certificate of insurance",
  COIs: "certificates of insurance",
  WC: "workers' compensation",
  SDR: "sales development representative",
  DM: "decision maker",
  CSLB: "California contractors state license board",
  FEIN: "federal employer identification number",
  TCPA: "Telephone Consumer Protection Act",
  DNC: "do-not-call",
  IRPM: "individual risk premium modification",
  BOP: "business owner's policy",
  LLC: "limited liability company",
  PR: "public relations",
  CI: "continuous integration",
  KB: "knowledge base",
  ASAP: "as soon as possible",
  FYI: "for your information",
  ETA: "estimated time of arrival",
};
const ACRONYM_RE = new RegExp(`\\b(${Object.keys(ACRONYM_WORDS).join("|")})\\b`, "g");
const PRICE_RE = /\$\s?\d|\b\d[\d,.]*\s?(dollars|bucks|percent|%)/i;
const acronymCounts = new Map<string, number>();

/** Names in the loader's dispositions that come from the small tree rather than a fragment. */
const NEUTRAL_NAMES: Array<[RegExp, string]> = [
  [/\{agency_name\}|\[agency name\]/gi, "the agency"],
  [/\{business_name\}|\[business name\]/gi, "your business"],
  [/\[producer name\]/gi, "the licensed producer"],
];

// ---------------------------------------------------------------- line plans
// A node's agent lines are a script, not a list of alternatives: the first line
// is usually what is said on entering, and the later lines are said after the
// caller answers. The loader holds one line per node (and one per direction),
// so the entry line is chosen here, by what the fragment says each line is
// for, and never by a rule that prefers lines without a placeholder (that rule
// picked a goodbye for two nodes). The script throws on a node that would use
// any line but the first and has no entry here.

interface EntryPlan {
  /** Fragment line numbers (from 0) the entry line comes from. */
  from: number[];
  /** The spoken line. Where it is not a verbatim fragment line, `how` says what was done to it. */
  text: string;
  how: string;
}
const ENTRY_PLAN: Record<string, EntryPlan> = {
  "open.wrong_number": {
    from: [0],
    text: "I'm sorry about that. Just to be sure, you aren't the business owner or someone who works for a contractor?",
    how: "line 1 with the fragment's own wording for when the caller does not yet know the business name (its bracket note); the goodbye (line 2) is said only when the ending happens",
  },
  "open.recording_objection": {
    from: [0],
    text: "Understood, and thank you for telling me. I'm not able to turn the recording off from here. Is it all right to continue with the call recorded?",
    how: "the first sentence is line 1; the second and third sentences are the honest wording of the compliance fragment's recording objection node (its lines 1 and 4), because line 1 ends the call and line 2 claims the recording stops, which the compliance fragment forbids",
  },
  "discovery.confirm_xdate": {
    from: [1],
    text: "When does your current workers' compensation policy renew?",
    how: "line 2, the fragment's line for when nothing is on file (line 1 reads back an on-file date the loader cannot supply)",
  },
  "discovery.renewed_recently": {
    from: [0],
    text: "That's helpful, thank you. So when is the next renewal?",
    how: "line 1 with its month slot turned into the question it stands for (the loader cannot fill a slot); lines 2 and 3 are statements for after the caller answers",
  },
  "discovery.handle_correction": {
    from: [0, 1],
    text: "Thanks for fixing that. I've got the new one instead of the old one. Did I get that right?",
    how: "lines 1 and 2 joined, with line 1's value slot dropped (the loader cannot fill it); line 2 alone is a statement with no question",
  },
  "objection.happy_current": {
    from: [1],
    text: "It is good that you have coverage in place. When does the policy renew, so the agency knows when to check in?",
    how: "line 2, the fragment's line for when the renewal month is not confirmed (line 1 names a month the loader cannot supply)",
  },
  "service.confirm_and_close": {
    from: [1],
    text: "Is there anything else you need passed along?",
    how: "line 2; line 1 reads back the need with slots the loader cannot fill, so the read-back is not spoken",
  },
  "close.confirm_callback_time": {
    from: [0],
    text: "So you'd like a call at the time you gave, at this number. Is that right?",
    how: "line 1 with its day and time slots written as 'the time you gave' (the loader cannot fill a slot)",
  },
  "close.confirm_message": {
    from: [0, 1],
    text: "I'll pass that to a licensed producer. Did I get your message right?",
    how: "line 2 followed by line 1's closing question; line 1's read-back slots cannot be filled",
  },
  "compliance.advice_redirect": {
    from: [0, 1, 2],
    text: "I'm not a licensed producer, so I can't give you a price or advice on coverage, and a guess from me could mislead you. A licensed producer can answer it properly. Shall I book a short call?",
    how: "sentences of lines 1, 2 and 3 joined into one line that fits every kind of request (the six lines are for six kinds of request, and the engine says one line on entry); the option slots in lines 1 and 2 cannot be filled",
  },
  "compliance.stop_apply": {
    from: [0],
    text: "Understood. I'm sorry for the interruption, and thank you for telling me.",
    how: "line 1 without its claim that the caller is removed and will not hear from us again: the removal is written only after the judge allows it, so the claim is said on the ending answer instead",
  },
  "compliance.legal_threat": {
    from: [0],
    text: "I'm sorry for the trouble. I'm not able to discuss legal matters, but I'll make sure a person at the agency reviews this.",
    how: "line 1 without its promise that nobody will contact the caller in the meantime: no hold on outreach is wired, so the promise would be untrue",
  },
  // Authored by patchAuthored below (the caller names the time; no calendar read) or folded into the node before them.
  "close.offer_times": { from: [], text: "", how: "authored" },
  "close.confirm_booking": { from: [], text: "", how: "authored" },
  "close.offer_live_transfer": { from: [], text: "", how: "authored" },
};

/** The line said when an answer ends the call, from the node's fragment lines. Said only when the ending actually happens. */
interface EndingPlan {
  from: number[];
  text: string;
  how: string;
}
const ENDING_PLAN: Record<string, EndingPlan> = {
  "open.wrong_number.confirms_the_number_is_wrong_for_the_business": {
    from: [1],
    text: "Thank you, and I'm sorry for the trouble. I'll note it so we don't use this number again. Have a good day.",
    how: "line 2, verbatim",
  },
  "open.recording_objection.refuses_the_recording_and_ends": {
    from: [0],
    text: "Understood. You can reach the agency directly. Thank you for calling.",
    how: "line 1 without its claim that the line cannot continue and without the published number slot",
  },
  "compliance.stop_apply.yes_explicit_quote_found": {
    from: [0, 1],
    text: "Understood. I'm removing you from all our calls, texts and emails, and you won't hear from us again. It's noted now. If anything from us still reaches you, please tell us and we will fix it right away.",
    how: "the removal claim of line 1 and line 2, said only once the judge has allowed the do-not-contact ending",
  },
  "compliance.legal_threat.about_being_contacted_or_recorded": { from: [2], text: "Thank you for letting me know. I've passed it on.", how: "line 3, verbatim (line 1's promise of no contact is not wired)" },
  "compliance.legal_threat.not_specified": { from: [2], text: "Thank you for letting me know. I've passed it on.", how: "line 3, verbatim" },
  "compliance.upset_deescalate.abusive_again_after_warning": {
    from: [3],
    text: "I'm going to end the call here. A person at the agency may follow up. Take care.",
    how: "line 4, verbatim",
  },
  "compliance.recording_objection.asks_to_delete_the_recording": {
    from: [2],
    text: "I've noted your request about the recording, and a person at the agency will follow up on it.",
    how: "line 3, verbatim",
  },
  "compliance.recording_objection.refuses_everything": {
    from: [2],
    text: "I've noted your request about the recording, and a person at the agency will follow up on it.",
    how: "line 3, verbatim",
  },
  "open.silence_or_noise.only_noise_or_hold_music_no_person": {
    from: [2],
    text: "I still can't hear you, so I'll end the call here. You're welcome to call back any time. Goodbye.",
    how: "line 3, verbatim",
  },
  "objection.not_interested.firm_or_repeated_no": { from: [2], text: "Thank you for your time. I will note that, and I will not keep you.", how: "line 3, verbatim" },
  "service.producer_offer.declines": { from: [2], text: "No problem at all. Thanks for calling.", how: "line 3, verbatim" },
  "service.confirm_and_close.wants_to_end_now": { from: [2], text: "Thank you for calling.", how: "line 3, verbatim" },
  "service.confirm_and_close.done_sensitive_or_upset": { from: [2], text: "Thank you for calling.", how: "line 3, verbatim" },
  "service.confirm_and_close.done_with_booked_time": { from: [2], text: "Thank you for calling.", how: "line 3, verbatim" },
  "compliance.possible_minor.clearly_a_minor": {
    from: [1],
    text: "That's okay. Could you ask a grown-up who looks after the business insurance to call us on the agency's number? Thank you, and take care.",
    how: "line 2, verbatim",
  },
};

/** A node's clarifying line when the fragment gives one that is not tagged as a clarifier: its retry line. */
const CLARIFY_PLAN: Record<string, { index: number; text: string }> = {
  "compliance.stop_clarify": { index: 1, text: "I'm sorry, I didn't catch that. Do you want us to stop calling and texting you altogether?" },
  "compliance.possible_minor": { index: 2, text: "Sorry, I missed that. Could you say it again?" },
};

/**
 * Nodes that must never hand a caller who may not want, or may not be able, to
 * talk to a person: still unclear ends with a hold for review instead. The
 * stop questions have the fragment's own route (compliance_review); the possible
 * minor node has none in the fragment, so this is the closest safe equivalent.
 */
const REVIEW_SAY = "Understood, then I'll leave it there. Thank you for your time.";
const ESCALATION_PLAN: Record<string, { disposition: string; say: string; from: string; basis: string }> = {
  "compliance.stop_clarify": { disposition: "compliance_review", say: REVIEW_SAY, from: "line 3 of this node", basis: "the fragment's answer still_unclear_after_one_retry routes to terminal:compliance_review" },
  "objection.confirm_stop": { disposition: "compliance_review", say: REVIEW_SAY, from: "the closing line of compliance.stop_clarify (its line 3), because this node has no closing line", basis: "the fragment's on-repeat exit routes to terminal:compliance_review" },
  "compliance.possible_minor": {
    disposition: "compliance_review",
    say: "That's okay. Could you ask a grown-up who looks after the business insurance to call us on the agency's number? Thank you, and take care.",
    from: "line 2 of this node",
    basis: "the fragment has no route for a possible minor who stays unclear; the closest safe equivalent is a hold for a person, never a handoff to a producer",
  },
};

// ---------------------------------------------------------------- keyword cues
// Cues for the answers on the booking and handoff paths. The keyword decision
// modules count each cue as one point (a lexicon entry may weigh two); one point
// scores 0.76 and two points 0.87, so a bar of 0.8 or more needs two cue hits or a lexicon entry.

const CUES: Record<string, string[]> = {
  "interrupts.emergency_or_safety": ["emergency", "911", "ambulance", "hospital", "bleeding", "heart attack", "hurt badly", "overdose"],
  "interrupts.threatens_legal_or_regulatory_action": ["lawyer", "attorney", "sue you", "lawsuit", "regulator", "report you", "attorney general", "do not call registry"],
  "close.offer_live_transfer.no_prefers_appointment": ["book", "schedule", "appointment", "book a time", "set up a time"],
  "close.offer_live_transfer.no_prefers_message": ["message", "leave a message", "take a message", "pass along"],
  "close.offer_live_transfer.busy_wants_later": ["busy", "later", "call me back", "not right now", "driving", "in a meeting"],
  "close.offer_live_transfer.asks_a_question_first": ["how long", "who will", "who am i", "what will", "question"],
  "close.offer_times.needs_to_check_with_someone": ["check with", "ask my", "talk to my", "my partner", "my wife", "my husband", "my boss"],
  "close.offer_times.neither_works_wants_later_contact": ["neither", "none of those", "another time", "call me later", "later"],
  "close.offer_times.declines_after_all": ["no thanks", "no thank you", "not interested", "changed my mind", "dont want"],
  "close.confirm_booking.wants_a_different_time": ["am", "pm", "tomorrow", "noon", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "actually"],
  "close.confirm_booking.corrects_a_detail": ["number is", "email is", "spelled", "spelling", "my email", "my number", "correction"],
  "close.confirm_booking.hesitant_or_may_not_make_it": ["maybe", "might not", "not sure", "may not", "depends"],
  "close.confirm_booking.withdraws": ["never mind", "forget it", "cancel", "dont want", "changed my mind", "no thanks", "no thank you"],
  "close.after_booking_prep.text_ok_to_this_number": ["yes", "sure", "okay", "text me", "text is fine", "go ahead", "that works"],
  "close.after_booking_prep.email_only": ["email", "e mail"],
  "close.after_booking_prep.no_written_confirmation": ["no text", "no email", "dont text", "no thanks", "not necessary", "dont need"],
  "close.after_booking_prep.gave_a_different_number": ["different number", "another number", "my cell", "this number instead"],
  "close.after_booking_prep.asks_a_question_or_objects": ["how much", "cost", "who is", "why", "question", "will this"],
};
/** Nodes on the booking and handoff paths: every real answer here must have cues or a lexicon entry, or the script stops. */
const KEYWORD_PATH_NODES = ["interrupts", "close.offer_live_transfer", "close.offer_times", "close.confirm_booking", "close.after_booking_prep", "entry.outbound"];

// ---------------------------------------------------------------- reading input

type Json = any;
const read = (file: string): Json => JSON.parse(readFileSync(file, "utf8"));
const fragments = {} as Record<FragmentName, Json>;
for (const f of FRAGMENTS) {
  fragments[f] = read(join(fragmentDir, `fragment-${f}.json`));
  for (const key of ["area", "nodes", "dispositions", "openQuestions"]) {
    if (!(key in fragments[f])) throw new Error(`fragment-${f}.json has no ${key}`);
  }
}
const small = read(join(repo, "src/decision-tree/tree.json")) as DecisionTreeData;

// ---------------------------------------------------------------- text helpers

function expandAcronyms(text: string): string {
  return text.replace(ACRONYM_RE, (m) => {
    acronymCounts.set(m, (acronymCounts.get(m) ?? 0) + 1);
    return ACRONYM_WORDS[m]!;
  });
}
/** Text the agent does not say: abbreviations spelled out, unknown template variables written as words. */
function plain(text: string | undefined): string {
  if (!text) return "";
  return expandAcronyms(text).replace(/\{(\w+)\}/g, (_, v: string) => v.replace(/_/g, " "));
}
/** Text the agent says: also no em-dash. */
function spoken(text: string): string {
  return expandAcronyms(text).replace(/\s*[—–]\s*/g, ", ");
}
const humanize = (s: string) => {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const labelOf = (id: string) => humanize(id.slice(id.indexOf(".") + 1));
const SPANISH_RE = /[¿¡ñáéíóúü]|^(gracias|hola|puedo|sí)\b/i;
const sentence = (s: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return m ? m[1]! : s.trim();
};

// ---------------------------------------------------------------- id resolution

const nodeIds = new Set<string>();
const sourceOf = new Map<string, { fragment: FragmentName; node: Json }>();
for (const f of FRAGMENTS) {
  for (const n of fragments[f].nodes) {
    if (sourceOf.has(n.id)) {
      fit(f, n.id, "duplicate id", `the id also appears in fragment-${sourceOf.get(n.id)!.fragment}.json`, "kept the first, ignored this copy", "none");
      continue;
    }
    sourceOf.set(n.id, { fragment: f, node: n });
    nodeIds.add(n.id);
  }
}
for (const [id, { fragment, node }] of sourceOf) {
  if (node.decidedBy === "tool_result" && !(id in FOLDED)) throw new Error(`${fragment}:${id} is decided by a tool result and has no fold rule`);
}

interface Target {
  next?: string;
  disposition?: string;
  fallback?: boolean;
  aliasNote?: string;
}
const dispositionName = (name: string) => TERMINAL_RENAMES[name] ?? name;

function resolveTarget(raw: string | null | undefined): Target {
  if (!raw) return {};
  if (raw.startsWith("terminal:")) return { disposition: dispositionName(raw.slice("terminal:".length)) };
  if (raw.startsWith("return:") || raw.startsWith("resume:")) return { next: FALLBACK_NODE, fallback: true };
  let id = raw;
  let aliasNote: string | undefined;
  if (ALIASES[id]) {
    const placeholder = id === "discovery.next_priority_question" || id === "objection.route" ? `; ${PLACEHOLDER_NOTE}` : "";
    aliasNote = `${id} read as ${ALIASES[id]!.to} (${ALIASES[id]!.stated ? "a fragment names this target" : "the fragments name the placeholder but not its target, so the target is my reading"}${placeholder})`;
    id = ALIASES[id]!.to;
  }
  while (FOLDED[id]) {
    aliasNote = `${aliasNote ? aliasNote + "; " : ""}${id} is decided by a tool result and is folded into ${FOLDED[id]}`;
    id = FOLDED[id]!;
  }
  if (HARNESS_NODES.includes(id) || REPLACED_BY_INTERRUPTS.includes(id)) id = "open.greeting";
  if (!nodeIds.has(id)) throw new Error(`target ${raw} resolves to ${id}, which is no node in any fragment`);
  return { next: id, ...(aliasNote ? { aliasNote } : {}) };
}

// ---------------------------------------------------------------- dispositions

const used = (set: Set<string>, v: string | undefined) => v && set.add(v);

interface DispositionBuild {
  name: string;
  meaning: string;
  durableByFragment: Map<string, boolean>;
  crmEquivalent: string;
}
const dispositionBuilds = new Map<string, DispositionBuild>();
for (const f of FRAGMENTS) {
  for (const d of fragments[f].dispositions as Json[]) {
    if (/[/\s]/.test(d.name)) {
      fit(f, "(dispositions)", "disposition", `the disposition entry "${d.name}" is three names in one string`, "skipped it; the fragment's other entries cover each name", "none");
      continue;
    }
    const name = dispositionName(d.name);
    if (name !== d.name) fit(f, "(dispositions)", "disposition", `${d.name} is not a name the rule judge knows`, `renamed to ${name}, which the judge ties to a real booking or transfer`, "Keep the rename, or teach the rule judge the fragment's names");
    const build = dispositionBuilds.get(name) ?? { name, meaning: plain(d.meaning), durableByFragment: new Map(), crmEquivalent: plain(d.crmEquivalent) };
    build.durableByFragment.set(f, d.durable === true);
    dispositionBuilds.set(name, build);
  }
}
for (const build of dispositionBuilds.values()) {
  const values = new Set(build.durableByFragment.values());
  const final = DURABLE_FINAL.has(build.name);
  if (values.size > 1) {
    fit("(several)", build.name, "disposition", `fragments disagree on durable: ${[...build.durableByFragment].map(([f, v]) => `${f} says ${v}`).join(", ")}`, `used durable=${final}`, "Which fragment is right?");
  } else if ([...values][0] !== final) {
    fit([...build.durableByFragment.keys()][0]!, build.name, "disposition", `the fragment says durable=${[...values][0]}`, `used durable=${final}: the rule judge accepts a durable ending only with a not-interested phrase or a stop request`, "Is this ending durable?");
  }
}

// ---------------------------------------------------------------- node areas

function areaOf(fragment: FragmentName, id: string): Area {
  switch (fragment) {
    case "open":
      return "open";
    case "discovery":
      return "discovery";
    case "service":
      return "service";
    case "compliance":
      return "safety";
    case "objection":
      return OBJECTION_ENTRY_NODES.includes(id) ? "entry" : id === "objection.confirm_stop" ? "safety" : "objection";
    case "close":
      return CLOSE_TRANSFER.includes(id) ? "transfer" : CLOSE_MESSAGE.includes(id) ? "message" : "booking";
  }
}
const FLOW_STEP: Partial<Record<Area, FlowStep>> = {
  open: "recognize_lead",
  discovery: "discovery",
  objection: "objection",
  booking: "booking",
  message: "message",
  transfer: "handoff",
};

// ---------------------------------------------------------------- lines

type LineKind = "clarifier" | "spanish" | "text_body" | "template" | "price" | "usable";
interface Lines {
  line?: string;
  /** Fragment line number of `line`. */
  lineIndex?: number;
  clarify?: string;
  clarifyIndex?: number;
  /** What each fragment line is, by line number. */
  kinds: LineKind[];
  notes: string[];
}
function pickLines(id: string, node: Json): Lines {
  const notes: string[] = [];
  let clarify: string | undefined;
  let clarifyIndex: number | undefined;
  const kinds: LineKind[] = [];
  const plainCandidates: Array<{ index: number; text: string }> = [];
  const conditionalCandidates: Array<{ index: number; text: string }> = [];
  for (const [index, l] of ((node.agentLines ?? []) as Json[]).entries()) {
    let t = String(l.line).trim();
    const clarifier = /^\(clarifier\)\s*/i.exec(t);
    if (clarifier) {
      kinds.push("clarifier");
      if (clarify === undefined) {
        clarify = t.slice(clarifier[0].length);
        clarifyIndex = index;
      }
      continue;
    }
    if (SPANISH_RE.test(t)) {
      kinds.push("spanish");
      continue;
    }
    if (/^text body/i.test(t) || /^\[/.test(t)) {
      kinds.push("text_body");
      continue;
    }
    let conditional = false;
    const lead = /^\([^)]*\)\s*/.exec(t);
    if (lead) {
      t = t.slice(lead[0].length);
      conditional = true;
    }
    const trail = /\s+\[[^\]]{12,}\]\s*$/.exec(t);
    if (trail) {
      t = t.slice(0, trail.index);
      conditional = true;
    }
    for (const [re, word] of NEUTRAL_NAMES) t = t.replace(re, word);
    if (PRICE_RE.test(t)) {
      kinds.push("price");
      continue;
    }
    if (/\[[^\]]*\]|\{[^}]*\}/.test(t) || !t) {
      kinds.push("template");
      continue;
    }
    kinds.push("usable");
    (conditional ? conditionalCandidates : plainCandidates).push({ index, text: spoken(t) });
  }
  const picked = plainCandidates[0] ?? conditionalCandidates[0];
  if (!plainCandidates[0] && conditionalCandidates[0]) notes.push("only a conditional line could be used");
  return {
    line: picked?.text,
    lineIndex: picked?.index,
    clarify: clarify ? spoken(clarify.replace(/\[[^\]]*\]/g, "").trim()) : undefined,
    clarifyIndex,
    kinds,
    notes,
  };
}

// ---------------------------------------------------------------- answers

interface BuiltNode {
  node: TreeNode;
  fragment: FragmentName;
  /** Answers moved to the interrupt block, by answer name. */
  lifted: string[];
}

const liftedTotals = new Map<string, number>();
const judgeFor = (name: string, meaning: string, bar: number, durable: boolean): NonNullable<TreeAnswer["judge"]> => {
  const minConfidence = Math.max(bar, MIN_BAR, durable ? DURABLE_BAR : 0);
  if (name === "do_not_contact") return { codeRules: ["the caller's own words ask for contact to stop"], question: "Did the caller ask, in their own words, never to be contacted again?", minConfidence };
  if (name === "not_interested") return { codeRules: ["the caller's own words refuse"], question: "Did the caller refuse in their own words?", minConfidence };
  return { codeRules: ["the caller's own words back it"], question: `Is this true of the caller's own words: ${meaning}`, minConfidence };
};
const blockedFor = (name: string): { say: string } => {
  if (name === "do_not_contact") return { say: "Just to be sure, would you like us to stop contacting you completely?" };
  if (name === "not_interested") return { say: "Sorry, did you want me to stop here?" };
  return { say: "Sorry, I want to be sure I understood you. Could you say that once more?" };
};
const isDurable = (name: string) => DURABLE_FINAL.has(name);

function buildAnswers(fragment: FragmentName, id: string, node: Json): { answers: TreeAnswer[]; lifted: string[] } {
  const answers: TreeAnswer[] = [];
  const lifted: string[] = [];
  const dropped: string[] = [];
  const toolDropped: string[] = [];
  const unclearRouted: string[] = [];
  const raised: string[] = [];
  const bothRoutes: string[] = [];
  const fallbackEdges: string[] = [];
  const aliasNotes = new Set<string>();

  for (const a of node.decision.answers as Json[]) {
    let name: string = a.answer;
    if (name === "returning_a_missed_call") {
      fit(fragment, id, "answer name", "the answer is called returning_a_missed_call; the validator and the keyword modules know returning_missed_calls", "renamed it", "none");
      name = "returning_missed_calls";
    }
    if (name === "unclear") {
      const t = resolveTarget(a.next);
      if (t.next && t.next !== id) unclearRouted.push(`${a.next}`);
      if (t.disposition) unclearRouted.push(`terminal:${t.disposition}`);
      continue;
    }
    if (a.minConfidence === null || a.minConfidence === undefined) {
      toolDropped.push(name);
      continue;
    }
    if (a.minConfidence === 0 || /^unclear/.test(name) || /^still_unclear/.test(name)) {
      dropped.push(name);
      continue;
    }
    const target = resolveTarget(a.next);
    if (target.aliasNote) aliasNotes.add(target.aliasNote);
    if (target.fallback) fallbackEdges.push(`${name}: ${a.next}`);
    if (!NEVER_LIFT_FROM(id) && target.next && INTERRUPT_COVERED_TARGETS.has(target.next) && !a.disposition) {
      lifted.push(name);
      liftedTotals.set(name, (liftedTotals.get(name) ?? 0) + 1);
      continue;
    }
    let disposition = target.disposition ?? (a.disposition ? dispositionName(a.disposition) : undefined);
    let next = target.next;
    if (next && a.disposition && !String(a.next).startsWith("terminal:")) {
      bothRoutes.push(`${name} (next ${a.next}, disposition ${a.disposition})`);
      disposition = undefined;
    }
    if (disposition) next = undefined;
    let bar = typeof a.minConfidence === "number" ? a.minConfidence : DEFAULT_BAR;
    if (bar < MIN_BAR) {
      raised.push(`${name} ${bar} to ${MIN_BAR}`);
      bar = MIN_BAR;
    }
    if (bar >= 1) bar = 0.99;
    if (disposition && isDurable(disposition) && bar < DURABLE_BAR) {
      raised.push(`${name} ${bar} to ${DURABLE_BAR} (durable ending ${disposition})`);
      bar = DURABLE_BAR;
    }
    const meaning = plain(a.meaning) || humanize(name);
    const out: TreeAnswer = { answer: name, meaning, minConfidence: bar };
    if (next) out.next = next;
    if (disposition) {
      out.disposition = disposition;
      // Every ending speaks a closing line, said only once the ending has really happened (the judge gate).
      const ending = ENDING_PLAN[`${id}.${name}`];
      out.say = ending?.text ?? CLOSING_LINE;
      if (ending) endingsUsed.push(`${id}.${name}`);
      out.onBlocked = blockedFor(disposition);
      out.judge = judgeFor(disposition, meaning, bar, isDurable(disposition));
    }
    const cues = CUES[`${id}.${name}`];
    if (cues) out.cues = cues;
    answers.push(out);
  }

  const f = fragment;
  if (lifted.length) fit(f, id, "interrupt", `${lifted.length} answers duplicate the tree level interrupt check: ${lifted.join(", ")}`, "left out of this node; the interrupt check asks them before every node", "none, see the interrupt decisions");
  if (dropped.length) fit(f, id, "unclear again", `answers that route after a second unclear: ${dropped.join(", ")}`, "dropped; after two clarifying lines the engine brings in a person (escalation)", "Should two unclear lines bring in a person, as the engine does, or take a message, as the fragments say?");
  if (toolDropped.length) fit(f, id, "tool result", `answers decided by a tool result, not by the caller: ${toolDropped.join(", ")}`, "dropped; the engine has no tool-result answers", "Which tool results should the engine read?");
  if (unclearRouted.length) fit(f, id, "unclear route", `the unclear answer routes to ${[...new Set(unclearRouted)].join(", ")}`, "route dropped; unclear asks this node's clarifying line, then escalates", "none, same as the unclear again decision");
  if (raised.length) fit(f, id, "bar", `bars changed to fit the validator (at least ${MIN_BAR}; at least ${DURABLE_BAR} for a durable ending): ${raised.join("; ")}`, "raised to the minimum", "Is a lower bar wanted for stop and safety answers? The validator forbids it");
  if (bothRoutes.length) fit(f, id, "next and disposition", `answers with both a next node and a disposition: ${bothRoutes.join("; ")}`, "kept the next node and dropped the disposition (a later node files it); the engine would otherwise end the call here and lose the rest of the flow", "Should these end the call at once?");
  if (fallbackEdges.length) fit(f, id, "return edge", `answers that go back to the interrupted node (${fallbackEdges.join("; ")})`, `sent to ${FALLBACK_NODE}, which asks where the call stands; the engine cannot return to the interrupted node`, "Should the engine learn to return to the interrupted node?");
  for (const note of aliasNotes) fit(f, id, "node id", note, "mapped", note.includes("my reading") ? "Confirm this reading" : "none");
  return { answers, lifted };
}

// ---------------------------------------------------------------- the line ledger

/** Which fragment lines each built node kept, and why the others went. Filled while nodes are built. */
interface LedgerEntry {
  fragment: FragmentName;
  kinds: LineKind[];
  entry: number[];
  authored: boolean;
  clarify?: number;
  endings: number[];
  escalation?: number;
}
const ledger = new Map<string, LedgerEntry>();
/** Entry line choices for the report: the nodes whose entry is not simply the fragment's first line. */
const entryChoices: Array<{ node: string; chosen: number[]; how: string }> = [];

// ---------------------------------------------------------------- building nodes

const continuationLine = (clarify: string) => clarify;
const OTHER_MEANING = "None of the answers listed here fits, but one of the further answers might.";

function buildNode(fragment: FragmentName, id: string, node: Json): BuiltNode[] {
  const area = areaOf(fragment, id);
  const lines = pickLines(id, node);
  const { answers, lifted } = buildAnswers(fragment, id, node);
  const plan = ENTRY_PLAN[id];
  if (!plan && lines.lineIndex !== undefined && lines.lineIndex !== 0) {
    throw new Error(`${id} would speak fragment line ${lines.lineIndex} on entry, not the first line, and has no entry in ENTRY_PLAN: choose the line by what the fragment says it is for`);
  }
  const authored = plan?.how === "authored";
  const entryLine = plan && !authored ? spoken(plan.text) : lines.line;
  const entryFrom = plan ? plan.from : lines.lineIndex !== undefined ? [lines.lineIndex] : [];
  const clarifyPlan = CLARIFY_PLAN[id];
  const clarifyText = clarifyPlan ? spoken(clarifyPlan.text) : lines.clarify;
  const clarifyIndex = clarifyPlan ? clarifyPlan.index : lines.clarifyIndex;
  const clarify = clarifyText ?? GENERIC_CLARIFY;
  if (!clarifyText) fit(fragment, id, "clarifying line", "no clarifier line in the fragment", `used the generic line "${GENERIC_CLARIFY}"`, "none");
  if (!entryLine && !authored) fit(fragment, id, "agent line", "no line without a placeholder, a price or a language switch", "the node says nothing on entry", "Write the line");
  for (const n of lines.notes) fit(fragment, id, "agent line", n, "used it", "none");
  if (plan && !authored) entryChoices.push({ node: id, chosen: plan.from, how: plan.how });
  if (plan && authored) entryChoices.push({ node: id, chosen: [], how: "authored by this script (see its authored record below), so no fragment line is the entry" });
  const escalationPlan = ESCALATION_PLAN[id];
  if (escalationPlan && id !== "compliance.possible_minor") {
    const routed = (node.decision.answers as Json[]).some((a) => a.disposition === escalationPlan.disposition && /unclear|hung_up/.test(a.answer)) || node.onRepeat?.disposition === escalationPlan.disposition;
    if (!routed) throw new Error(`${id}: the fragment has no still-unclear route to ${escalationPlan.disposition}`);
  }
  if (escalationPlan) fit(fragment, id, "still unclear", `the fragment sends a caller who is still unclear to ${escalationPlan.disposition}: ${escalationPlan.basis}`, `the node carries its own escalation (end ${escalationPlan.disposition}, saying ${escalationPlan.from}); the engine uses it instead of bringing in a person (a small engine change, listed in the report)`, "none, the route is the fragment's (or the closest safe equivalent, said above)");
  ledger.set(id, {
    fragment,
    kinds: lines.kinds,
    entry: entryFrom,
    authored,
    clarify: clarifyIndex,
    endings: Object.entries(ENDING_PLAN).filter(([k]) => k.startsWith(`${id}.`)).flatMap(([, v]) => v.from),
    escalation: escalationPlan && escalationPlan.from.startsWith("line ") ? Number(/line (\d+)/.exec(escalationPlan.from)![1]) - 1 : undefined,
  });

  const repeatKey = area === "objection" ? id.slice("objection.".length) : undefined;
  const flowStep = FLOW_STEP[area];
  const base = {
    label: labelOf(id),
    area,
    ...(flowStep ? { flowStep } : {}),
    situation: plain(node.situation),
    agentGoal: plain(node.agentGoal),
    clarify,
    ...(escalationPlan ? { escalation: { say: spoken(escalationPlan.say), disposition: escalationPlan.disposition } } : {}),
    ...(repeatKey ? { repeatKey } : {}),
    ...(Array.isArray(node.neverSay) && node.neverSay.length ? { neverSay: node.neverSay.map(String) } : {}),
    sources: (Array.isArray(node.sources) ? node.sources : []).map(String),
    ...(typeof node.crmAlignment === "string" ? { crmEquivalent: plain(node.crmAlignment) } : {}),
  };
  const question = plain(node.decision.question);
  const unclear: TreeAnswer = { answer: "unclear", minConfidence: 0 };

  const parts: TreeNode[] = [];
  let rest = answers.slice();
  let k = 1;
  while (rest.length > MAX_ANSWERS - 1) {
    const chunk = rest.splice(0, MAX_ANSWERS - 2);
    const partId = k === 1 ? id : `${id}_more${k}`;
    const nextId = `${id}_more${k + 1}`;
    chunk.push({ answer: "other", meaning: OTHER_MEANING, minConfidence: MIN_BAR, next: nextId, carry: true });
    parts.push(partNode(partId, k));
    parts[parts.length - 1]!.decision = { question, answers: [...chunk, unclear] };
    k++;
  }
  parts.push(partNode(k === 1 ? id : `${id}_more${k}`, k));
  parts[parts.length - 1]!.decision = { question, answers: [...rest, unclear] };
  if (parts.length > 1) fit(fragment, id, "answer limit", `${answers.length} real answers, and the validator allows ${MAX_ANSWERS - 1} besides unclear`, `split into ${parts.length} chained nodes (${parts.map((p) => p.id).join(", ")}): the first answers the question, an "other" answer carries the same caller line to the next`, "Is the chain acceptable, or should a node be cut down?");

  function partNode(partId: string, index: number): TreeNode {
    const part: TreeNode = {
      id: partId,
      ...base,
      label: index === 1 ? base.label : `${base.label} (further answers ${index})`,
      ...(repeatKey && index > 1 ? { repeatKey: `${repeatKey}_more${index}` } : {}),
      agentLines: index === 1 ? (entryLine ? [{ line: entryLine }] : []) : [{ line: continuationLine(clarify) }],
      ...(index === 1 && Array.isArray(node.handoffTriggers) && node.handoffTriggers.length ? { handoffTriggers: node.handoffTriggers.map((t: unknown) => plain(String(t))) } : {}),
    } as TreeNode;
    if (!part.agentLines?.length) delete (part as Partial<TreeNode>).agentLines;
    return part;
  }
  return parts.map((node) => ({ node, fragment, lifted }));
}

// ---------------------------------------------------------------- authored nodes

const SLOT_LINE = "So that is {slotWords}. Shall I book it? Please say yes to confirm.";
const READ_BACK_SAY = SLOT_LINE;

function patchAuthored(built: Map<string, TreeNode>): void {
  const by = (id: string): TreeNode => {
    const n = built.get(id);
    if (!n) throw new Error(`authored patch needs ${id}`);
    return n;
  };
  const keep = (n: TreeNode, names: string[]) => (n.decision!.answers as TreeAnswer[]).filter((a) => names.includes(a.answer));

  // Offer a time: the fragment offers two calendar slots; the harness has no calendar read, so the caller names the time.
  const offerTimes = by("close.offer_times");
  offerTimes.agentLines = [{ line: "What day and time would suit you for a call with a licensed producer?" }];
  offerTimes.clarify = "Sorry, what day and time suit you? For example, Tuesday at 10 AM.";
  offerTimes.decision!.answers = [
    {
      answer: "accepts_time",
      meaning: "Names a day and a clock time.",
      minConfidence: 0.75,
      extract: { as: "slot", with: "time" },
      next: "close.confirm_booking",
      say: READ_BACK_SAY,
    },
    ...keep(offerTimes, ["needs_to_check_with_someone", "neither_works_wants_later_contact", "declines_after_all"]),
    { answer: "unclear", minConfidence: 0 },
  ];
  fit("close", "close.offer_times", "authored", "the fragment offers two open calendar slots from a calendar read, and the harness has no calendar read (it books a time the caller names)", "replaced the slot answers (chose_first_slot, chose_second_slot, proposed_other_time) with accepts_time, which takes a day and clock time from the caller's words; kept the other three answers", "Is a calendar read going to be built? Until then the caller names the time");

  // Confirm the booking: read back, plain yes, book through the judge gate.
  const confirm = by("close.confirm_booking");
  confirm.agentLines = [{ line: SLOT_LINE }];
  confirm.clarify = "Sorry, shall I book {slotWords}? Please say yes or no.";
  const afterPrepLine = by("close.after_booking_prep").agentLines?.[0]?.line;
  confirm.decision!.answers = [
    {
      answer: "yes",
      meaning: "Plainly agrees to the time that was read back.",
      minConfidence: 0.8,
      action: { type: "book", from: "slot" },
      next: "close.after_booking_prep",
      say: `Booked for {slotWords}.${afterPrepLine ? ` ${afterPrepLine}` : ""}`,
      onBlocked: { say: "Let me check that time again. What day and time suit you?", next: "close.offer_times" },
      judge: { codeRules: ["the caller's own words back it", "the time was named by the caller and read back"], question: "Did the caller agree to this time in their own words?", minConfidence: 0.8 },
    },
    {
      answer: "wants_a_different_time",
      meaning: "Names a different day and time.",
      minConfidence: 0.7,
      extract: { as: "slot", with: "time" },
      next: "close.confirm_booking",
      say: READ_BACK_SAY,
      cues: CUES["close.confirm_booking.wants_a_different_time"]!,
    },
    ...keep(confirm, ["corrects_a_detail", "hesitant_or_may_not_make_it", "withdraws"]),
    { answer: "unclear", minConfidence: 0 },
  ];
  fit("close", "close.confirm_booking", "authored", "the fragment's booking tool result node (close.booking_result) decides what to say after the booking; the engine books through the judge gate instead", "the answer yes books through the judge gate and moves to close.after_booking_prep, saying the booking and that node's first line; confirms_all became yes (the keyword modules refuse a yes on a negated line only for the answer named yes); contact detail saves are not wired", "Which contact details must be saved before the booking, and who saves them?");

  // Offer the live transfer: no presence read exists, so the line does not claim anyone is free.
  const offer = by("close.offer_live_transfer");
  offer.agentLines = [{ line: "I can try to connect you with a licensed producer now. Would you like that? This call stays recorded." }];
  offer.clarify = "Sorry, would you like me to connect you with a licensed producer, book a time, or take a message?";
  offer.decision!.answers = [
    {
      answer: "yes",
      meaning: "A clear yes in the caller's own words to being connected to a licensed producer now.",
      minConfidence: 0.85,
      action: { type: "transfer", reason: "caller_requested" },
      disposition: "handed_off",
      say: "I'm connecting you with a licensed commercial producer who will go through the details with you.",
      onBlocked: { say: "Just to be sure, would you like me to connect you with a person? Please tell me in your own words." },
      judge: { codeRules: ["the caller's own words ask for a person"], question: "Did the caller ask, in their own words, to be connected to a person?", minConfidence: 0.85 },
    },
    ...keep(offer, ["no_prefers_appointment", "no_prefers_message", "busy_wants_later", "asks_a_question_first"]),
    { answer: "unclear", minConfidence: 0 },
  ];
  fit("close", "close.offer_live_transfer", "authored", "the fragment says a producer is free now, from a presence read the harness does not have, and the next node (close.transfer_in_progress) is decided by a transfer result", "the entry line offers to try a connection and claims no availability; the answer yes carries the transfer through the judge gate and ends handed_off; close.check_producer_available and close.transfer_in_progress are folded away", "Who is the person on the other end of the transfer, and how is availability read?");
}

// ---------------------------------------------------------------- interrupts

function buildInterrupts(): DecisionTreeData["interrupts"] {
  const a = (answer: string, meaning: string, minConfidence: number, next: string, extra: Partial<TreeAnswer> = {}): TreeAnswer => ({
    answer,
    meaning,
    minConfidence,
    next,
    ...(CUES[`interrupts.${answer}`] ? { cues: CUES[`interrupts.${answer}`] } : {}),
    ...extra,
  });
  return {
    question: small.interrupts.question,
    clarify: small.interrupts.clarify,
    answers: [
      { answer: "none", minConfidence: 0 },
      { answer: "unclear", minConfidence: 0 },
      a("asks_if_ai", "Asks whether this is a robot, a machine, an automated system or an artificial intelligence.", MIN_BAR, "open.ai_question"),
      a("asks_for_person", "Asks to speak with a person now, such as a human, the owner, a manager or a producer.", 0.75, "close.offer_live_transfer"),
      a("emergency_or_safety", "Someone is hurt or in danger now, or the caller says they will harm themselves or others.", MIN_BAR, "compliance.emergency_safety"),
      a("asks_to_stop", "Asks, in any wording, for the calls to stop or to be taken off the list, or says something that could be a refusal of the call. The stop is confirmed before anything is written.", MIN_BAR, "compliance.stop_clarify"),
      a("threatens_legal_or_regulatory_action", "Mentions a lawyer, a lawsuit, a regulator or the do-not-call registry, or says the call or the recording is illegal.", MIN_BAR, "compliance.legal_threat"),
      a("upset", "Is angry, swearing or hostile, with no legal threat and no stop request.", 0.7, "compliance.upset_deescalate"),
    ],
  };
}

// ---------------------------------------------------------------- assembling

const built = new Map<string, TreeNode>();
/** Nodes the script does not build, with the reason their lines go. */
const notBuilt = new Map<string, string>();
const liftedByNode = new Map<string, string[]>();
const order: string[] = [];
for (const f of FRAGMENTS) {
  for (const raw of fragments[f].nodes as Json[]) {
    const id: string = raw.id;
    if (sourceOf.get(id)?.fragment !== f) continue;
    if (HARNESS_NODES.includes(id)) {
      notBuilt.set(id, "the node is decided by the harness before the tree runs");
      fit(f, id, "harness node", "decided by rules from the lead store, the suppression lists and the clock, before the tree runs", "left out; the harness runs these checks first (disclosure, calling window, suppression)", "Do the harness checks match this node? See the fragment's open questions");
      continue;
    }
    if (REPLACED_BY_INTERRUPTS.includes(id)) {
      notBuilt.set(id, "the node is replaced by the tree level interrupt check");
      fit(f, id, "interrupts", "the compliance router is a node asked before every area", "replaced by the tree level interrupt check (six answers; the validator allows eight with none and unclear)", "Which compliance triggers must be checked before every node? Four are not (recording objection, possible minor, wrong party, advice request)");
      continue;
    }
    if (id in FOLDED) {
      notBuilt.set(id, "the node is decided by a tool result and folded into the node before it");
      if (id === "close.booking_result") entryChoices.push({ node: id, chosen: [], how: "folded into close.after_booking_prep (decided by the booking result, not by the caller), so no entry line is spoken here" });
      fit(f, id, "tool result", `decided by a tool result (${raw.decidedBy ?? "the fragment folds it with the tool node it follows"}), not by what the caller says`, `left out; edges into it go to ${FOLDED[id]}`, "Which tool results should the engine read?");
      continue;
    }
    for (const part of buildNode(f, id, raw)) {
      built.set(part.node.id, part.node);
      order.push(part.node.id);
    }
    liftedByNode.set(id, []);
  }
}
for (const key of Object.keys(ENDING_PLAN)) if (!endingsUsed.includes(key)) throw new Error(`ENDING_PLAN ${key} matches no ending answer in the built tree`);
patchAuthored(built);

// The outbound entry: the small tree's, pointed at the fragments' nodes.
const outbound = structuredClone(small.nodes.find((n) => n.id === "entry.outbound")!);
// The engine puts its own artificial intelligence disclosure in front of this line when the line does not contain
// the words "AI assistant", so the line carries only the recording notice (the compliance fragment's entry gate, line 1).
outbound.agentLines = [{ line: "This call is recorded. Is this {firstName}?", direction: "outbound" }];
fit("compliance", "compliance.entry_gate", "agent line", "the outbound first turn had no recording notice; the fragment's entry gate says 'This call is recorded' on the outbound opening", "entry.outbound now says 'This call is recorded. Is this {firstName}?' after the engine's own disclosure", "none");
outbound.decision!.answers = outbound.decision!.answers.map((a) => {
  if (a.answer === "yes") return { ...a, next: "open.identity_gate" };
  if (a.answer === "no") return { ...a, next: "open.gatekeeper" };
  return a;
});
fit("(small tree)", "entry.outbound", "authored", "no fragment has an outbound entry: the fragments are written for a lead calling back", "used the small tree's outbound entry; a yes goes to open.identity_gate and a no to open.gatekeeper", "Is this the right way into the fragments for an outbound call?");

// Drop nodes nothing reaches.
const interrupts = buildInterrupts();
const starts = { inbound: "open.greeting", outbound: "entry.outbound" };
const nodeMap = new Map<string, TreeNode>([[outbound.id, outbound], ...built]);
const reachable = new Set<string>();
const queue: string[] = [starts.inbound, starts.outbound, ...interrupts.answers.flatMap((a) => [a.next, a.onBlocked?.next]).filter((x): x is string => Boolean(x))];
while (queue.length) {
  const id = queue.pop()!;
  if (reachable.has(id)) continue;
  const n = nodeMap.get(id);
  if (!n) throw new Error(`a route points at ${id}, which was not built`);
  reachable.add(id);
  for (const to of [n.next, ...(n.decision?.answers ?? []).flatMap((a) => [a.next, a.onBlocked?.next])]) if (to) queue.push(to);
}
for (const id of [...nodeMap.keys()]) {
  if (reachable.has(id)) continue;
  const frag = sourceOf.get(id)?.fragment ?? "(chain)";
  fit(frag, id, "unreachable", "no answer in the assembled tree leads here", "left out of the tree (not invented a route)", "Which answer should lead here?");
  nodeMap.delete(id);
}

// Dispositions that are used.
const usedDispositions = new Set<string>(["handed_off", "soft_declined"]);
for (const n of nodeMap.values()) for (const a of n.decision?.answers ?? []) used(usedDispositions, a.disposition);
for (const a of interrupts.answers) used(usedDispositions, a.disposition);
for (const n of nodeMap.values()) used(usedDispositions, n.escalation?.disposition);
const dispositions: TreeDisposition[] = [];
const smallDispositions = new Map(small.dispositions.map((d) => [d.name, d]));
for (const name of [...new Set([...dispositionBuilds.keys(), "handed_off", "soft_declined"])].sort((x, y) => x.localeCompare(y))) {
  if (!usedDispositions.has(name)) {
    fit("(dispositions)", name, "disposition", "no answer in the assembled tree ends with it", "left out of the list", "none");
    continue;
  }
  const authored = smallDispositions.get(name);
  const build = dispositionBuilds.get(name);
  if (authored && ["handed_off", "soft_declined", "booked"].includes(name)) {
    dispositions.push({ ...authored, durable: false });
    continue;
  }
  dispositions.push({
    name,
    label: humanize(name),
    durable: DURABLE_FINAL.has(name),
    meaning: build?.meaning ?? authored?.meaning ?? humanize(name),
    crmEquivalent: build?.crmEquivalent || authored?.crmEquivalent || "none: no matching CRM disposition",
  });
}

const tree: DecisionTreeData = {
  id: "full",
  version: "1",
  start: starts.inbound,
  starts,
  maxClarifications: small.maxClarifications,
  escalation: small.escalation,
  interrupts,
  repeatRule: small.repeatRule,
  dispositions,
  nodes: [...nodeMap.values()],
};

// ---------------------------------------------------------------- coverage by the keyword modules

const covered = (answer: string, cues?: string[]) => Boolean(LEXICON[answer]) || Boolean(cues?.length);
const uncoveredOnPath: string[] = [];
const nodeCoverage: Array<{ id: string; real: number; covered: number }> = [];
for (const n of tree.nodes) {
  const real = (n.decision?.answers ?? []).filter((a) => a.answer !== "unclear" && a.answer !== "other");
  nodeCoverage.push({ id: n.id, real: real.length, covered: real.filter((a) => covered(a.answer, a.cues)).length });
  if (KEYWORD_PATH_NODES.includes(n.id)) for (const a of real) if (!covered(a.answer, a.cues)) uncoveredOnPath.push(`${n.id}.${a.answer}`);
}
for (const a of tree.interrupts.answers) if (a.answer !== "none" && a.answer !== "unclear" && !covered(a.answer, a.cues)) uncoveredOnPath.push(`interrupts.${a.answer}`);
if (uncoveredOnPath.length) throw new Error(`answers on the booking and handoff paths have no cues or lexicon entry: ${uncoveredOnPath.join(", ")}`);

// ---------------------------------------------------------------- the actions the fragments describe and the loader cannot carry

const unwired: Array<{ fragment: string; node: string; count: number }> = [];
for (const n of tree.nodes) {
  const src = sourceOf.get(n.id.replace(/_more\d+$/, ""));
  if (!src || n.id.includes("_more")) continue;
  const count = ((src.node.actions ?? []) as Json[]).filter((x) => x.destructive === true && x.judgeBefore === true).length;
  const wired = (n.decision?.answers ?? []).filter((a) => a.action).length;
  if (count > wired) unwired.push({ fragment: src.fragment, node: n.id, count: count - wired });
}
for (const u of unwired) fit(u.fragment, u.node, "actions", `${u.count} judged destructive actions in the fragment have no action in the loader`, "not wired; only book and transfer are wired, on the authored nodes", "Which of these become real actions (save details, save quote field, send text)?");

const capped = [...sourceOf.values()].filter(({ node }) => node.maxVisits !== undefined).length;
for (const { fragment, node } of sourceOf.values()) {
  if (node.maxVisits !== undefined && nodeMap.has(node.id)) fit(fragment, node.id, "visit cap", `visit cap ${node.maxVisits} and an overflow exit`, "not expressible; only the clarification limit and the repeat rule bound loops", "Should the engine count visits per node?");
  if (node.onRepeat && nodeMap.has(node.id)) fit(fragment, node.id, "repeat rule", `its own repeat exit (${JSON.stringify(node.onRepeat.disposition ?? node.onRepeat.next)})`, "the tree's single repeat rule applies instead: the second landing on this objection class ends soft_declined", "Should each class have its own repeat exit?");
}

// ---------------------------------------------------------------- what happened to every fragment line

const finalIds = new Set(nodeMap.keys());
const builtFinal = (id: string) => [...finalIds].some((x) => x === id || x.startsWith(`${id}_more`));
const DROP_REASONS = {
  node_out: "the node is not in the tree (harness check, tool result, interrupt replacement or unreachable)",
  spanish: "Spanish line: the loader has no language field and the engine speaks the first line only",
  text_body: "text message body: no send text action is wired",
  template: "an unfilled placeholder the loader cannot fill",
  price: "states a price, which the agent never says",
  extra_clarifier: "a second clarifying line (the loader holds one)",
  authored: "the node's line is authored in this script (no calendar read, no presence read)",
  follow_up: "a follow-up line said after the caller answers: the loader holds one entry line per node (and one per direction), and an answer's own line replaces the next node's line, so a follow-up line fits only on an ending answer, where it is kept when it fits (see the closing lines above)",
} as const;
type DropReason = keyof typeof DROP_REASONS;
const KEPT_LABELS = { entry: "entry line", clarify: "clarifying line", ending: "closing line on an ending", escalation: "closing line on a hold for review", outbound: "recording notice on the outbound first turn" } as const;
type KeptKind = keyof typeof KEPT_LABELS;

interface Tally {
  total: number;
  kept: Record<KeptKind, number>;
  dropped: Record<DropReason, number>;
  spanishKept: number;
  handoffTotal: number;
  handoffKept: number;
}
const tallies = new Map<FragmentName, Tally>();
for (const f of FRAGMENTS) {
  tallies.set(f, {
    total: 0,
    kept: { entry: 0, clarify: 0, ending: 0, escalation: 0, outbound: 0 },
    dropped: { node_out: 0, spanish: 0, text_body: 0, template: 0, price: 0, extra_clarifier: 0, authored: 0, follow_up: 0 },
    spanishKept: 0,
    handoffTotal: 0,
    handoffKept: 0,
  });
}
const spanishByNode: Array<{ fragment: string; node: string; count: number }> = [];
for (const [id, { fragment, node }] of sourceOf) {
  const t = tallies.get(fragment)!;
  const lines = (node.agentLines ?? []) as Json[];
  t.total += lines.length;
  t.handoffTotal += Array.isArray(node.handoffTriggers) ? node.handoffTriggers.length : 0;
  const entry = ledger.get(id);
  const inTree = !notBuilt.has(id) && Boolean(entry) && builtFinal(id);
  if (inTree) {
    const first = nodeMap.get(id);
    t.handoffKept += first?.handoffTriggers?.length ?? 0;
  }
  const spanish = lines.filter((l) => SPANISH_RE.test(String(l.line).trim())).length;
  if (spanish) spanishByNode.push({ fragment, node: id, count: spanish });
  lines.forEach((l, i) => {
    if (id === "compliance.entry_gate") {
      // Line 1 is the outbound opening: its recording sentence is now in entry.outbound.
      if (i === 1) t.kept.outbound++;
      else t.dropped.node_out++;
      return;
    }
    if (!inTree || !entry) return void t.dropped.node_out++;
    if (entry.entry.includes(i)) return void t.kept.entry++;
    if (entry.clarify === i) return void t.kept.clarify++;
    if (entry.endings.includes(i)) return void t.kept.ending++;
    if (entry.escalation === i) return void t.kept.escalation++;
    const kind = entry.kinds[i];
    if (kind === "clarifier") return void t.dropped.extra_clarifier++;
    if (kind === "spanish") return void t.dropped.spanish++;
    if (kind === "text_body") return void t.dropped.text_body++;
    if (kind === "template") return void t.dropped.template++;
    if (kind === "price") return void t.dropped.price++;
    return void (entry.authored ? t.dropped.authored++ : t.dropped.follow_up++);
  });
}
for (const f of FRAGMENTS) {
  const t = tallies.get(f)!;
  const kept = Object.values(t.kept).reduce((a, b) => a + b, 0);
  const dropped = Object.values(t.dropped).reduce((a, b) => a + b, 0);
  if (kept + dropped !== t.total) throw new Error(`line ledger for ${f}: kept ${kept} plus dropped ${dropped} is not the ${t.total} lines in the fragment`);
}
// The spoken lines of the tree that come from a fragment line, for the headline of the table.
const totalLines = [...tallies.values()].reduce((a, t) => a + t.total, 0);
const totalKept = [...tallies.values()].reduce((a, t) => a + Object.values(t.kept).reduce((x, y) => x + y, 0), 0);

const genericEndings = tree.nodes.flatMap((n) => (n.decision?.answers ?? []).filter((a) => a.disposition && a.say === CLOSING_LINE).map((a) => `${n.id}.${a.answer}`));

// ---------------------------------------------------------------- interrupts the block cannot hold

const interruptGap = [
  { name: "recording objection", fragmentAnswer: "recording_objection", destination: "compliance.recording_objection", fragmentBar: 0.6, nodeTargets: ["open.recording_objection", "compliance.recording_objection"] },
  { name: "possible minor", fragmentAnswer: "possible_minor", destination: "compliance.possible_minor", fragmentBar: 0.5, nodeTargets: ["compliance.possible_minor"] },
  { name: "wrong party", fragmentAnswer: "wrong_party", destination: "compliance.wrong_party", fragmentBar: 0.7, nodeTargets: ["open.wrong_number", "compliance.wrong_party"] },
].map((g) => {
  const byArea = new Map<string, number>();
  for (const n of tree.nodes) {
    if (n.id.includes("_more")) continue;
    if ((n.decision?.answers ?? []).some((a) => a.next && g.nodeTargets.includes(a.next))) byArea.set(n.area, (byArea.get(n.area) ?? 0) + 1);
  }
  return { ...g, byArea: [...byArea].sort((a, b) => a[0].localeCompare(b[0])).map(([area, n]) => `${area} ${n}`) };
});

// ---------------------------------------------------------------- validate and write

const problems = treeProblems(tree);
if (problems.length) {
  console.error(`${problems.length} validator problems in the assembled tree:`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(tree, null, 2)}\n`);

// ---------------------------------------------------------------- the report

const IMPORTANT_QUESTIONS: Record<FragmentName, number[]> = {
  open: [0, 2, 3, 4, 6],
  discovery: [0, 1, 2, 3, 7],
  objection: [2, 4, 5, 6, 10],
  service: [0, 1, 3, 5, 6],
  close: [0, 1, 2, 3, 9],
  compliance: [0, 1, 3, 4, 7],
};

const byKind = new Map<string, number>();
for (const r of records) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
const clip = (s: string, n = 420) => {
  const t = plain(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n).replace(/\s\S*$/, "")} ...` : t;
};
const noCover = nodeCoverage.filter((c) => c.real > 0 && c.covered === 0).map((c) => c.id);
const partCover = nodeCoverage.filter((c) => c.covered > 0 && c.covered < c.real).map((c) => `${c.id} (${c.covered} of ${c.real})`);
const fullCover = nodeCoverage.filter((c) => c.real > 0 && c.covered === c.real).map((c) => c.id);

const lines: string[] = [];
const push = (...l: string[]) => lines.push(...l);
push(
  "# Full decision tree: fit report",
  "",
  "Written by `scripts/assemble-decision-tree.ts` from the six fragments. Do not edit by hand: change the script and run it again.",
  "",
  `**Headline.** The six fragments are assembled into one tree (${tree.nodes.length} nodes, ${dispositions.length} dispositions, ${tree.interrupts.answers.length - 2} interrupt answers). ${records.length} places did not fit the loader and are listed below; the tree passes the validator.`,
  "",
  "## Decisions Dana must make",
  "",
  "1. **Two unclear lines.** The engine brings in a person after two clarifying lines. The fragments send the caller to taking a message instead. Which one? (Three safety nodes are now the exception: a stop question or a possible minor that stays unclear ends as `compliance_review`, never a handoff; see the section on engine changes.)",
  "2. **Stop and safety bars.** The validator forbids a bar under 0.6, and the fragments set stop, legal, minor and upset answers at 0.5. They were raised to 0.6, so those answers are slightly less sensitive. Accept, or relax the validator?",
  "3. **Durable endings the rule judge cannot accept.** The rule judge allows a durable ending only for a stop request or a not-interested phrase. `wrong_number` and `declined_ai_or_recording` are durable in the fragments, so the judge refuses them and the call stays on the node. Teach the judge, or make them non-durable?",
  "4. **Message endings.** The judge knows `message_left`, which needs a saved message. The tree ends `message_taken` and saves nothing, because no save action is wired. Wire the message save, or map to `message_left`?",
  "5. **Actions not wired.** Only booking and the person transfer are wired. Every other judged action the fragments describe (saving details, quote fields, texts, suppression writes, callbacks) is listed per node below. Which become real?",
  "6. **No calendar and no presence read.** The caller names the time (the fragment offers two calendar slots) and the transfer offer claims no one is free. Are a calendar read and a producer presence read going to be built?",
  "7. **The person handoff needs the caller's own words in the confirming line.** The rule judge refuses a bare yes to the tree's own connect offer, because its transfer check wants a person phrase in the caller's last line. The tree sets no required phrase and says so when it is refused. Should the judge accept a plain yes after the offer? (Judge change, not made here.)",
  "8. **Four triggers are not in the interrupt check, and the block cannot hold them.** The interrupt block holds six answers, and the validator allows eight with none and unclear, so it is full. Recording objection, possible minor, wrong party and advice request stay on the nodes that carry them (the exact reach is in the section on interrupts below). Raise the limit for the interrupt block (it asks one question on every caller line, so more answers make every line a little less sure), or accept this?",
  "9. **Returning to the interrupted node.** The engine cannot return; every return goes to `close.pre_ask_check`, which asks where the call stands. Build a return edge, or accept this?",
  "10. **Chained answers.** Nodes over the answer limit are split into chained nodes (the first six answers, then an `other` answer that carries the same caller line on). Accept this, or cut the answers down?",
  "11. **Two ids are placeholders the close fragment asks to be reconciled** (its open question 9: \"Cross-area node ids are placeholders for the other fragments ... The merge step must reconcile them\"). The discovery fragment names the target of the first: `discovery.next_priority_question` is `discovery.choose_next_question`. No fragment names the target of the second: `objection.route` is read as `objection.classify` (my reading). Confirm.",
  "12. **Sibling node meanings that may differ.** `compliance.opt_out` and `compliance.opt_out_requested` are both read as `compliance.stop_apply`; the service fragment wants every stop to go through `compliance.stop_clarify`. Which?",
  "13. **Wrong number and the declined recording still cannot end a call with the rule judge** (decision 3). The goodbye is now spoken only when the ending happens, but the rule judge refuses a durable ending without a not-interested phrase, so a caller who says \"wrong number\" is met with a clarifying line again and again. Make `wrong_number` and `declined_ai_or_recording` non-durable, or teach the judge (not done here: the judge is off limits)?",
  "14. **Still unclear at a possible minor has no route in the fragment.** The fragment loops it back to itself. The tree ends it as `compliance_review` (a hold for a person) saying the grown-up line, so no producer is ever handed a possible minor. Accept?",
  "15. **`close.final_disposition` still says goodbye on entry and then waits.** Its agent goal in the fragment is to say a short goodbye and then file the outcome, so the goodbye is spoken before the ending is filed; if the judge refuses a lasting `not_interested`, the caller hears \"Sorry, did you want me to stop here?\" after a goodbye. Fix by choosing a goodbye-free entry for this node (nothing in the fragment is one), or accept it?",
  "16. **A real model sees answer names, not meanings.** The engine asks a decision module with the answer names only; the catalog models build their prompt from `answerCriteria` when it is given, and the engine does not give it. Pass each answer's meaning (a small engine change) before a real model decides on the full tree.",
  "",
  "## Counts by kind",
  "",
  ...[...byKind].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `- ${k}: ${n}`),
  "",
  "## Judge and harness changes the tree needs (not made here)",
  "",
  "- Rule judge: no rule for `wrong_number` or `declined_ai_or_recording` (decision 3).",
  "- Rule judge: a bare yes to the connect offer is refused (decision 7). A negated line such as \"I don't want to speak to a person\" still passes the judge's phrase check, so the tree keeps the transfer on the answer named `yes`, which the keyword modules refuse on a negated line.",
  "- Harness: no calendar read, no producer presence read, no return to the interrupted node, no visit counter, no per-class repeat exit.",
  "- Harness: the stop check ends the call as `do_not_contact` before the tree, so the tree's `compliance.stop_apply` is reached only after the interrupt check asks and the caller confirms.",
  "- Harness files (`call-harness.ts`, `play-wiring.ts`, `agent-line-guard.ts`, `persona-card.ts`) name no stub or fixture node id, so the default switch needs no change there. None of them was edited.",
  "",
  "## Entry line choices (the nodes whose entry is not simply the fragment's first line)",
  "",
  "A node's lines are a script, so the line said on entering is chosen by what the fragment says each line is for, not by a rule. A goodbye is spoken only when the ending actually happens.",
  "",
  ...entryChoices.sort((a, b) => a.node.localeCompare(b.node)).map((c) => `- ${c.node}: ${c.chosen.length ? `entry from fragment line ${c.chosen.map((n) => n + 1).join(" and ")} (lines are counted from 1)` : "no fragment line is the entry"}. ${c.how}.`),
  "",
  "Endings that speak a fragment line instead of the generic closing line (said only once the judge allows the ending):",
  "",
  ...endingsUsed.map((e) => `- ${e}: ${ENDING_PLAN[e]!.how}`),
  `- ${genericEndings.length} other ending answers say "${CLOSING_LINE}" because their node has no closing line that fits (or the caller is not on the line): ${genericEndings.join(", ")}. So no ending is silent.`,
  "",
  "## Recording is never claimed stopped",
  "",
  "`open.recording_objection` no longer says \"I'll stop the recording now\". The compliance fragment forbids claiming the recording stopped (the harness always records) and marks that line for a platform that can stop recording. It is dropped, and a test checks that no spoken line in the tree claims the recording was stopped or paused.",
  "",
  "## Fragment lines kept and dropped, exactly",
  "",
  `The fragments hold ${totalLines} agent lines. ${totalKept} are spoken by the tree (kept); the rest are dropped for the reasons in the columns. The kept and dropped columns add up to the total for every fragment (the script stops if they do not).`,
  "",
  "| Fragment | Lines | Kept: entry | Kept: clarifying | Kept: closing | Kept: other | Dropped: Spanish | Dropped: text body | Dropped: placeholder | Dropped: price | Dropped: extra clarifier | Dropped: authored node | Dropped: follow-up | Dropped: node not in tree | Handoff triggers (kept of total) |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...FRAGMENTS.map((f) => {
    const t = tallies.get(f)!;
    return `| ${f} | ${t.total} | ${t.kept.entry} | ${t.kept.clarify} | ${t.kept.ending} | ${t.kept.escalation + t.kept.outbound} | ${t.dropped.spanish} | ${t.dropped.text_body} | ${t.dropped.template} | ${t.dropped.price} | ${t.dropped.extra_clarifier} | ${t.dropped.authored} | ${t.dropped.follow_up} | ${t.dropped.node_out} | ${t.handoffKept} of ${t.handoffTotal} |`;
  }),
  `| all | ${totalLines} | ${[...tallies.values()].reduce((a, t) => a + t.kept.entry, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.kept.clarify, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.kept.ending, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.kept.escalation + t.kept.outbound, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.spanish, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.text_body, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.template, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.price, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.extra_clarifier, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.authored, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.follow_up, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.dropped.node_out, 0)} | ${[...tallies.values()].reduce((a, t) => a + t.handoffKept, 0)} of ${[...tallies.values()].reduce((a, t) => a + t.handoffTotal, 0)} |`,
  "",
  "Why each column drops (\"Kept: other\" is the closing line of a hold for review, and the recording notice added to the outbound first turn):",
  "",
  ...Object.values(DROP_REASONS).map((r) => `- ${r}`),
  "",
  `**Spanish lines (${spanishByNode.reduce((a, b) => a + b.count, 0)}).** The loader has no language field and the engine says the first line that fits the direction, so a Spanish line could not be chosen even if it were kept. All are dropped; carrying them needs a language field in the loader, an engine change to pick by language, and the language switch flow. Per node: ${spanishByNode.map((x) => `${x.node} ${x.count}`).join(", ")}.`,
  "",
  `**Handoff triggers.** The loader has no field for them and the engine reads none. The ${[...tallies.values()].reduce((a, t) => a + t.handoffKept, 0)} triggers of nodes that are in the tree ride along on the node as \`handoffTriggers\` (data only, never spoken). The ${[...tallies.values()].reduce((a, t) => a + t.handoffTotal - t.handoffKept, 0)} triggers of nodes left out of the tree are dropped with their node. Most of them are already answers that route to the named node.`,
  "",
  "## Interrupts the block cannot hold",
  "",
  "The interrupt block is full (six answers; the validator allows eight with none and unclear). The fragment's compliance router has these further triggers, and today each is reachable only from the nodes listed (a trigger spoken at any other node is not caught):",
  "",
  ...interruptGap.map((g) => `- ${g.name}: fragment destination ${g.destination}, bar ${g.fragmentBar}${g.fragmentBar < MIN_BAR ? ` (the validator forbids a bar under ${MIN_BAR}, so it would be raised to ${MIN_BAR})` : ""}. Reachable from the nodes of these areas (node counts): ${g.byArea.join(", ") || "none"}.`),
  "- advice request: fragment destination compliance.advice_redirect, bar 0.6; reachable only from open.state_purpose.",
  "",
  "## Engine and loader changes made for this report",
  "",
  "- Each node may carry its own `escalation` (a non-durable ending and a closing line). When a caller stays unclear past the clarifying lines, the engine ends there instead of bringing in a person (`src/decision/engine.ts`, five lines in `escalate`; types in `src/decision/tree.ts` and `src/decision-tree/types.ts`; the validator checks it). Used by compliance.stop_clarify and objection.confirm_stop (the fragment's route to `compliance_review`) and compliance.possible_minor (no route in the fragment; the closest safe equivalent, so a possible minor is never handed to a producer).",
  "- Each node may carry `handoffTriggers` (data only, never read by the engine).",
  "",
  "## Which copy of each fragment is newest",
  "",
  "- Only one copy of each fragment exists: the directory named on the command line (found by searching the whole thread storage of the thread that built it). The repository history of `src/decision-tree` holds no fragment.",
  "- By file modification time the pairs are: open, objection, service and close have the Markdown and JSON written within seconds of each other and agreeing (every node, answer and line in the JSON is in the Markdown). Discovery: the Markdown is about 29 seconds newer than the JSON, and they disagree (the Markdown is a prose companion; its answer names and lines differ from the JSON, though the node ids match). Compliance: the JSON is about 17 seconds newer than the Markdown, and they disagree (the Markdown is a short summary; it lacks the answers and lines). The JSON was used for all six, because it is the form with the nodes, answers and bars.",
  "- Decision: confirm the discovery JSON is the version to keep, since its Markdown is newer.",
  "",
  "## What the keyword modules can answer",
  "",
  `The default keyword decision modules (mock Jev and mock OpenAI) answer an answer only through a lexicon entry or a cue on the answer. Cues were written for every real answer on the booking and handoff paths: the interrupt check, \`entry.outbound\`, \`close.offer_live_transfer\`, \`close.offer_times\`, \`close.confirm_booking\` and \`close.after_booking_prep\`. The script stops if one is missing.`,
  "",
  `- Nodes with every real answer covered (${fullCover.length}): ${fullCover.join(", ") || "none"}`,
  `- Nodes partly covered (${partCover.length}): ${partCover.join(", ") || "none"}`,
  `- Nodes the keyword modules cannot answer at all (${noCover.length}); the real decision model answers these: ${noCover.join(", ") || "none"}`,
  "- `discovery.choose_next_question` and `close.write_handoff_note` ask about call state, not the caller's words, so only the real decision model can answer them.",
  "",
  "## Open questions the fragments carry",
  "",
);
for (const f of FRAGMENTS) {
  const qs = fragments[f].openQuestions as string[];
  push(`### ${f}: ${qs.length} open questions. The five most important:`, "");
  IMPORTANT_QUESTIONS[f].forEach((i, n) => push(`${n + 1}. ${clip(qs[i] ?? "")}`));
  push("");
}
push(
  "## Every place a fragment did not fit",
  "",
  "Format: fragment, node, kind: problem. Done: what the script did. Decision: what Dana must decide.",
  "",
);
const sorted = [...records].sort((a, b) => FRAGMENT_ORDER(a.fragment) - FRAGMENT_ORDER(b.fragment) || a.node.localeCompare(b.node) || a.kind.localeCompare(b.kind));
function FRAGMENT_ORDER(f: string): number {
  const i = (FRAGMENTS as readonly string[]).indexOf(f);
  return i < 0 ? 99 : i;
}
for (const r of sorted) push(`- ${r.fragment}, ${r.node}, ${r.kind}: ${plain(r.problem)}. Done: ${plain(r.action)}. Decision: ${r.decision}.`);
push("", "## Abbreviations spelled out in fragment text", "", ...[...acronymCounts].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `- "${ACRONYM_WORDS[k]}" (${n} times)`), "");
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, `${lines.join("\n")}\n`);

console.log(`ok: ${tree.nodes.length} nodes, ${dispositions.length} dispositions, ${records.length} fit records -> ${outFile}`);
