/**
 * Renders each prompt layer to plain text for a voice model. Content comes from the
 * playbook, the enforcement rules and the personality data; this file only decides
 * how it reads and which sentences belong to the legal layer.
 *
 * Every line is made of pieces tagged "behaviour" or "legal". Under the suspended
 * legal blocks mode the legal pieces are left out; behaviour pieces are never left out.
 */

import {
  INBOUND_RECORDING_DISCLOSURE,
  OUTBOUND_AI_TRUTHFUL_ANSWER,
  callOpening,
  knownLeadConfirmation,
  type CallOpening,
} from "../../compliance/disclosures.js";
import { readDataFile } from "../data-files.js";
import { ENFORCEMENT_RULES, RULE_ENFORCEMENT } from "../rules.js";
import type { LegalBlocksMode } from "../types.js";
import type { PersonalityProfile } from "./personality.js";
import { FACT_LABELS, fillSlots, knownFacts, missingFactKeys, redactPriorNotes } from "./slots.js";
import { cleanText, dropInternalSentences, ensureSentenceEnd, isSpokenLine, lowerFirst, quotedStrings } from "./text.js";
import type { PromptContext, PromptLayerId, SectionLayer } from "./types.js";

interface PlaybookItem {
  id: string;
  fields: Record<string, string>;
}
interface PlaybookSection {
  heading: string;
  items: PlaybookItem[];
}
interface Playbook {
  core: string;
  sections: PlaybookSection[];
}

let playbookCache: Playbook | undefined;
function playbook(): Playbook {
  playbookCache ??= readDataFile<Playbook>("playbook.json");
  return playbookCache;
}

/** The playbook sections whose heading starts with this number, such as "6" for all discovery parts. */
function sectionsNumbered(n: number): PlaybookSection[] {
  return playbook().sections.filter((s) => s.heading.startsWith(`${n}. `));
}

/** One playbook item by its identifier, such as "Disclosure-03". */
export function playbookItem(id: string): PlaybookItem {
  for (const section of playbook().sections) {
    const found = section.items.find((item) => item.id === id);
    if (found) return found;
  }
  throw new Error(`playbook_item_unknown:${id}`);
}

export function playbookItemIds(): string[] {
  return playbook().sections.flatMap((s) => s.items.map((i) => i.id)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pieces, rows, rendering
// ---------------------------------------------------------------------------

type PieceLayer = "behaviour" | "legal";
interface Piece {
  layer: PieceLayer;
  text: string;
}
interface Row {
  pieces: Piece[];
  /** The pieces that hold the words the agent speaks; the quoted strings in them are spoken example lines. */
  say?: Piece[];
}

const b = (text: string): Piece => ({ layer: "behaviour", text });
const l = (text: string): Piece => ({ layer: "legal", text });
const line = (text: string): Row => ({ pieces: [b(text)] });

/** Wording that belongs to the legal layer wherever it appears in the data. */
const LEGAL_WORDING: RegExp[] = [
  /,? and that the call is recorded/,
  /two attempts at most per agreed time, /,
  /; they are never permission to call outside the agreed time or the legal window/,
  /\s*Reply STOP to opt out\./,
  /, and this call is recorded/,
  /,? y esta llamada se graba/,
];

/** Splits a text into behaviour and legal pieces at the legal wording. */
function tagLegal(text: string, patterns: RegExp[] = LEGAL_WORDING): Piece[] {
  let pieces: Piece[] = [b(text)];
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, "g");
    pieces = pieces.flatMap((piece) => {
      if (piece.layer === "legal") return [piece];
      const out: Piece[] = [];
      let last = 0;
      for (const match of piece.text.matchAll(global)) {
        const at = match.index ?? 0;
        if (at > last) out.push(b(piece.text.slice(last, at)));
        out.push(l(match[0]));
        last = at + match[0].length;
      }
      if (last < piece.text.length) out.push(b(piece.text.slice(last)));
      return out.length ? out : [piece];
    });
  }
  return pieces;
}

function renderPieces(pieces: Piece[], mode: LegalBlocksMode): string {
  const kept = pieces.filter((p) => mode === "enforced" || p.layer === "behaviour");
  return kept.map((p) => p.text).join("").replace(/ {2,}/g, " ").trim();
}

interface Env {
  ctx: PromptContext;
  mode: LegalBlocksMode;
  profile?: PersonalityProfile;
}

interface RenderedSection {
  id: string;
  title: string;
  layer: SectionLayer;
  text: string;
  say: string[];
}

function finish(id: string, title: string, rows: Row[], env: Env): RenderedSection | undefined {
  const layers = new Set<PieceLayer>();
  const lines: string[] = [];
  const say: string[] = [];
  for (const row of rows) {
    const text = renderPieces(row.pieces, env.mode);
    if (!text) continue;
    lines.push(text);
    for (const piece of row.pieces) if (env.mode === "enforced" || piece.layer === "behaviour") layers.add(piece.layer);
    if (row.say) say.push(...quotedStrings(renderPieces(row.say, env.mode)).filter(isSpokenLine));
  }
  if (lines.length === 0) return undefined;
  layers.add("behaviour");
  const only = layers.size === 1 ? [...layers][0] : "mixed";
  const body = fillSlots([`## ${title}`, ...lines].join("\n"), env.ctx);
  return { id, title, layer: only, text: body, say: say.map((s) => fillSlots(s, env.ctx)) };
}

// ---------------------------------------------------------------------------
// Safety floor
// ---------------------------------------------------------------------------

/** The non-removable floor: short on purpose, and the same for every setup. */
export function renderFloor(env: Env): RenderedSection {
  const rows = [
    "You are an artificial intelligence assistant, and you say so whenever it matters or you are asked. You never claim to be a person.",
    "You are not a licensed producer. A licensed producer, who is a person, does everything below.",
    "Never state or estimate a price. Never give coverage advice, compare coverage or prices, judge whether anyone qualifies, bind or start coverage, take payment, or change or cancel a policy. Offer to book the licensed producer instead.",
    "Never pressure anyone, and never invent claims, stories, quotes or records.",
    "Never ask for or read out sensitive identifiers: social security numbers, tax identifiers, dates of birth, licence numbers, card or bank numbers, passwords.",
    "When the caller asks you to stop, stop at once.",
    "Never guess a fact. If you do not have it, say a licensed producer will confirm it.",
  ].map((text) => `- ${text}`);
  const section = finish("floor", "Safety floor (always on)", rows.map(line), env);
  return section as RenderedSection;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Replacement wording for items whose every sentence is a review note or an archive
 * reference, or whose quoted phrase is something the agent must not say.
 */
const BODY_OVERRIDES: Record<string, string> = {
  "Opener-02": 'This is [agency name] calling about the renewal date on your workers\' compensation policy. Do not say only that the agency reached out; it tells the caller nothing.',
  "Follow-up-11": "Send written follow-up on weekdays and inside the recipient's allowed hours. How often you follow up is capped by the compliance rules, not by a routine.",
  "Contractor-01": "When artisan contractors are reachable: weekdays 15:30 to 17:00 and Saturday 09:00 to 12:00, never during the working day. Use these to choose which slots to offer when the lead texts back; they are never permission to call outside the agreed time or the legal window.",
};

/** The cleaned text of one field of a playbook item, or its override. */
function bodyOf(item: PlaybookItem, field: string): string {
  return BODY_OVERRIDES[item.id] ?? cleanText(item.fields[field] ?? "");
}

function itemText(id: string, field: string): string {
  return cleanText(playbookItem(id).fields[field] ?? "");
}

/** The spoken line a pure reference such as "Disclosure-03 or Disclosure-06." stands for. */
function referencedLines(text: string): string[] | undefined {
  const ids = text.match(/^((?:Disclosure|Discovery)-\d{2})(?: or ((?:Disclosure|Discovery)-\d{2}))?\.?$/);
  if (!ids) return undefined;
  return [ids[1], ids[2]].filter((id): id is string => Boolean(id)).flatMap((id) => {
    const text = playbookItem(id).fields.lineOrRule ?? playbookItem(id).fields.question ?? "";
    const quotes = quotedStrings(text);
    const line = id === "Disclosure-03" ? quotes.find((q) => q.startsWith("No,")) : quotes[0];
    return line ? [`"${line}"`] : [];
  });
}

function responseText(item: PlaybookItem, field: string): string {
  const raw = item.fields[field] ?? "";
  const lines = referencedLines(raw.trim());
  return lines ? lines.join(" or ") : bodyOf(item, field);
}

function identityRows(env: Env): Row[] {
  const rows: Row[] = [];
  rows.push({ pieces: tagLegal(cleanText(playbook().core)) });
  rows.push(line("Answers you give, close to word for word:"));
  const realPerson = quotedStrings(playbookItem("Disclosure-03").fields.lineOrRule).find((q) => q.startsWith("No,"));
  const personPieces = [
    b('- Asked whether you are a real person: "'),
    b(realPerson ?? "No, I'm an artificial intelligence assistant for [agency name]. The licensed producer I can book you with is a person."),
    b('"'),
  ];
  rows.push({ pieces: personPieces, say: personPieces });
  const machinePieces = [b('- Asked whether you are a robot, a computer or an artificial intelligence: "'), b(OUTBOUND_AI_TRUTHFUL_ANSWER), b('"')];
  rows.push({ pieces: machinePieces, say: machinePieces });
  rows.push(line("- Answer the same way whatever words the caller uses."));
  for (const id of ["Disclosure-04", "Disclosure-05", "Disclosure-06", "Disclosure-09"]) {
    const pieces = [b("- "), ...tagLegal(itemText(id, "lineOrRule"))];
    rows.push({ pieces, say: pieces });
  }
  return rows;
}

const RULE_ORDER = ENFORCEMENT_RULES.map((r) => r.id);

function exampleClause(example: string): string {
  const trimmed = example.trim();
  if (trimmed.startsWith('"')) {
    const first = quotedStrings(trimmed)[0];
    return first ? ` Example to avoid: "${first}"` : "";
  }
  const segment = trimmed.split(/;\s*/)[0].replace(/\.$/, "");
  return segment ? ` Example to avoid: ${lowerFirst(segment)}.` : "";
}

function rulesRows(): Row[] {
  const rows: Row[] = [
    line("These rules hold on every call. If a request runs into one, say so plainly and offer to book the licensed producer."),
    line("### Never"),
  ];
  const ordered = [...ENFORCEMENT_RULES].sort((x, y) => RULE_ORDER.indexOf(x.id) - RULE_ORDER.indexOf(y.id));
  const push = (kind: string) => {
    for (const rule of ordered.filter((r) => r.kind === kind)) {
      const layer = RULE_ENFORCEMENT[rule.id].layer;
      const statement = ensureSentenceEnd(dropInternalSentences(rule.statement));
      rows.push({ pieces: [{ layer, text: `- ${rule.id}: ${statement}${exampleClause(rule.example)}` }] });
    }
  };
  push("never");
  rows.push(line("### Only a licensed producer does these. You never do them; you note the request and offer to book the producer"));
  push("producer_only");
  return rows;
}

/**
 * The call's opening: the one the harness fixed for the call, or else one made
 * from the facts (an inbound caller is not known without the harness saying so;
 * an outbound call is to the contact on file).
 */
function openingOf(ctx: PromptContext): CallOpening {
  if (ctx.opening) return ctx.opening;
  const leadFirstName = ctx.direction === "outbound" ? ctx.contactName?.trim().split(/\s+/)[0] : undefined;
  return callOpening({ producerFirstName: ctx.producerFirstName, agencyName: ctx.agencyName, leadFirstName });
}

/** The disclosure sentences as pieces: the recording sentence, present only while the recording notice is on, is legal wording. */
function disclosurePieces(opening: CallOpening): Piece[] {
  return opening.disclosure.flatMap((part, i) => {
    const text = i === 0 ? part : ` ${part}`;
    return [part === INBOUND_RECORDING_DISCLOSURE ? l(text) : b(text)];
  });
}

const NO_ACCOUNT_BEFORE_CONFIRMED = "Say nothing about the account or the renewal date to anyone until the named person is confirmed.";

function disclosureRows(env: Env): Row[] {
  const rows: Row[] = [];
  const opening = openingOf(env.ctx);
  const recordingOn = opening.disclosure.includes(INBOUND_RECORDING_DISCLOSURE);
  if (env.ctx.direction === "inbound" && !opening.confirm) {
    const first = [b('1. First turn, word for word, with nothing before or after it: "'), ...disclosurePieces(opening), b('"')];
    rows.push(line("This is an inbound call: the caller dialled the agency. The first turn below is fixed and stands alone; the guidance decides what follows it."));
    rows.push({ pieces: first, say: first });
    const second = [b('2. Second turn, after the first has finished: the guidance decides it, so say what the guidance gives you. It usually sounds like this: "Thanks for calling [agency name]. How can I help you today?"')];
    rows.push({ pieces: second, say: second });
    rows.push(line("Do not put the first turn inside a greeting or change a word of it."));
  } else {
    const confirm = opening.confirm ?? knownLeadConfirmation("[contact name on file]");
    rows.push(
      line(
        env.ctx.direction === "inbound"
          ? "This is an inbound call from a number on a known lead's record, so you know who is calling: confirm it is them, never ask who they are."
          : "This is an outbound call you place to a lead who agreed by text to a call at a set time.",
      ),
    );
    const first = [b('First turn, the disclosure word for word with nothing before it: "'), ...disclosurePieces(opening), b('"')];
    rows.push({ pieces: first, say: first });
    const ask = [b(`Then, in the same turn, confirm who you are speaking with (the words may change, the meaning may not): "${confirm}"`)];
    rows.push({ pieces: ask, say: ask });
    rows.push(line("Then stop and wait for the answer. Never ask a known lead who they are or the name of their business. If they say yes, the guidance gives the next question; if they say no, or someone else answered, the guidance takes it from there."));
    rows.push(line(NO_ACCOUNT_BEFORE_CONFIRMED));
  }
  if (env.ctx.language === "es") {
    rows.push(line("The lead's preferred language is Spanish. After the opening line, offer to continue in Spanish and keep every rule, in Spanish, at the same standard."));
  }
  const [, spanishOutbound, spanishSwitch] = quotedStrings(playbookItem("Disclosure-07").fields.lineOrRule);
  const switchPieces = [
    b(
      `- Spanish is supported at the same standard as English. Always open in English as above; if the caller speaks Spanish or asks for it, continue in Spanish and offer the switch: "${spanishSwitch ?? "¿Prefiere seguir en español?"}"`,
    ),
  ];
  rows.push({ pieces: switchPieces, say: switchPieces });
  if (env.ctx.direction === "outbound" && spanishOutbound) {
    // Only the playbook line's disclosure sentence: its renewal sentence would name the account before the lead
    // is confirmed, so the Spanish confirmation question takes its place (its wording needs a native speaker's review).
    const disclosureEs = spanishOutbound.match(/^[^.]*\./)?.[0] ?? spanishOutbound;
    // The confirmation question is "Is this {name}?" (knownLeadConfirmation); older records said "Am I speaking with {name}?".
    const named = opening.confirm?.match(/^(?:Is this|Am I speaking with) (.+)\?$/)?.[1] ?? "[contact name on file]";
    const confirmed = `${disclosureEs} ¿Hablo con ${named}?`;
    const spoken = recordingOn ? confirmed : confirmed.replace(/,? y esta llamada se graba/, "");
    const pieces = [b("- If the lead's preferred language is Spanish, open with this instead, then offer the switch: \""), ...tagLegal(spoken), b('"')];
    rows.push({ pieces, say: pieces });
  }
  const notes = quotedStrings(playbookItem("Disclosure-10").fields.lineOrRule)[0];
  if (notes) {
    const pieces = [l(`- If a caller asks what happens to what they say: "${notes}"`)];
    rows.push({ pieces, say: pieces });
  }
  return rows;
}

/** The decision module, not this section, picks each next step; the steps are background for the voice model. */
export const FLOW_IS_BACKGROUND =
  "A decision module picks each next step of the call and sends it to you as guidance: the line to say or the question to ask next. Only the first opening turn, the disclosure, is fixed word for word. The second opening turn and every question after it, the caller's name and business included, come from the guidance: say what it gives you. The steps below are background, so you know where each step fits; they are not a script. Never recite them in order, never skip ahead to the next one on your own, and never ask a question again because it appears here.";

function flowRows(env: Env): Row[] {
  const inbound = env.ctx.direction === "inbound";
  const [section] = sectionsNumbered(inbound ? 2 : 3);
  const rows: Row[] = [
    line(FLOW_IS_BACKGROUND),
    line(inbound ? "This is how an inbound call usually goes." : "This is how an outbound call usually goes."),
  ];
  for (const item of section.items) {
    const override = FLOW_OVERRIDES[item.id];
    if (override) {
      rows.push(...override.map((row) => ({ ...row, say: row.say ?? row.pieces.filter((p) => p.layer === "behaviour") })));
      continue;
    }
    const state = item.fields.state;
    const pieces = [b(`- ${state}: `), ...tagLegal(cleanText(item.fields.whatTheAgentDoes))];
    rows.push({ pieces, say: pieces });
  }
  return rows;
}

/**
 * Steps whose data text names code, so they are restated in call terms. The calling
 * window and attempt limits stay legal wording.
 */
const FLOW_OVERRIDES: Record<string, Row[]> = {
  "Inbound-1": [line("- Opening: say the first opening turn, the disclosure, exactly as given in the opening line section, before anything else. The second opening turn there shows what usually follows; the guidance decides it.")],
  "Inbound-2": [line('- Who and why: "Can I get your name and the name of the business?" Then confirm against the lead record one fact at a time, and do the authority check before any account detail.')],
  "Inbound-3": [
    line(
      "- Route: new business or a renewal review goes to the discovery questions. Existing client service (certificate, add a vehicle, change, cancel, payment): take the request, pass it to the service team and change nothing. A loss being reported: give the claims line on file at once and do not assess coverage.",
    ),
  ],
  "Inbound-4": [line("- Discovery: ask the discovery questions in priority order, one question at a time.")],
  "Inbound-6": [line('- Cannot book: take a message and write the handoff note. "I couldn\'t book a time today. I\'ll pass your details and the times that suit you to a licensed producer."')],
  "Outbound-0": [
    {
      pieces: [l("- Before dialling: the call is placed only inside the legal calling window in the lead's local time and only at the time the lead agreed to by text. You never extend or repeat a call outside them.")],
    },
  ],
  "Outbound-1": [line("- Opening: say the outbound opening line from the opening line section, word for word. The reason you give is the text agreement and the renewal, which must both be on the record.")],
  "Outbound-2": [line('- Still a good time?: "Is now still a good time for a couple of minutes?" The lead agreed only to a call, not to a sales conversation, so check first.')],
  "Outbound-8": [
    {
      pieces: [
        b("- No answer: "),
        l("two attempts at most per agreed time. "),
        b("Leave no message on either attempt and do not call again in a ladder. The lead's callback arrives as an inbound call and starts with the inbound opening."),
      ],
    },
  ],
};

function itemRows(sectionNumber: number, label: (item: PlaybookItem) => string, body: (item: PlaybookItem) => string): Row[] {
  return sectionsNumbered(sectionNumber).flatMap((s) =>
    s.items.map((item) => {
      const text = body(item);
      const pieces = [b(`- ${label(item)}: `), ...tagLegal(text)];
      return { pieces, say: pieces } satisfies Row;
    }),
  );
}

function openersRows(): Row[] {
  return [
    line("Use an opener only when the facts it needs are on file and true."),
    ...itemRows(4, (i) => cleanText(i.fields.openerPattern), (i) => bodyOf(i, "agentLine")),
  ];
}

function gatekeeperRows(): Row[] {
  return [
    line("Whoever answers is not always the person you need. Share no account details with anyone until the named person is confirmed."),
    ...itemRows(5, (i) => cleanText(i.fields.situation), (i) => bodyOf(i, "agentLineOrRule")),
  ];
}

function discoveryRows(): Row[] {
  const rows: Row[] = [line("Ask one question at a time, in this order. Record what the caller says in their own words.")];
  for (const section of sectionsNumbered(6)) {
    const part = section.heading.split(" > ")[1] ?? "Questions";
    rows.push(line(`### ${part}`));
    if (section.items[0]?.fields.field !== undefined) {
      rows.push(line("Record only these quote fields. Store each as the caller said it, with the period it covers. Never add other fields."));
      for (const item of section.items) {
        const field = item.fields.field.replace(/`/g, "");
        const priority = /^\d+$/.test(item.fields.priority) ? `priority ${item.fields.priority}` : item.fields.priority;
        rows.push(line(`- ${field} (${priority}): ${item.fields.storedAs}`));
      }
      continue;
    }
    for (const item of section.items) {
      const pieces = [b("- "), ...tagLegal(cleanText(item.fields.question))];
      rows.push({ pieces, say: pieces });
    }
  }
  return rows;
}

function objectionRows(): Row[] {
  const rows: Row[] = [line("Answer each objection once, then move toward booking the producer. A second no ends the topic.")];
  for (const section of sectionsNumbered(7)) {
    const part = section.heading.split(" > ")[1];
    if (part) rows.push(line(`### ${part}`));
    for (const item of section.items) {
      const f = item.fields;
      if (f.callerAsks !== undefined) {
        const response = tagLegal(cleanText(f.agentLine));
        rows.push({ pieces: [b(`- If the caller asks ${cleanText(f.callerAsks)}: `), ...response], say: response });
        continue;
      }
      const response = tagLegal(responseText(item, "agentLine"));
      const handling = cleanText(f.whenToHandOffOrExit ?? "");
      rows.push({
        pieces: [b(`- Caller says ${cleanText(f.objection)}. Response: `), ...response, ...(handling ? [b(` Handling: ${handling}`)] : [])],
        say: response,
      });
    }
  }
  return rows;
}

function bookingRows(): Row[] {
  return itemRows(8, (i) => cleanText(i.fields.pattern), (i) => bodyOf(i, "agentLineOrRule"));
}

function followupRows(): Row[] {
  const rows: Row[] = [
    line("Written messages exist only to get the lead onto a call. A text sets, confirms or moves a call time, only on a channel the lead agreed to, and never carries a price."),
    line("Do not leave voicemail messages."),
  ];
  const q = quotedStrings(playbookItem("Disclosure-08").fields.lineOrRule)[0] ?? "";
  const sender = q.split(" ... ")[0];
  const footer = q.includes("Reply STOP to opt out.") ? "Reply STOP to opt out." : "";
  rows.push(line(`- Every written message starts by naming the sender, the agency and the assistant, for example: "${sender} ..."`));
  if (footer) rows.push({ pieces: [l(`- Every written message ends with the opt-out instruction: "${footer}"`)] });
  rows.push(line('- Never open with a bare "Is this [name]?" text.'));
  const items = sectionsNumbered(9).flatMap((s) => s.items).filter((item) => item.id.startsWith("Follow-up"));
  for (const item of items) {
    const pieces = [b(`- ${cleanText(item.fields.pattern)}: `), ...tagLegal(bodyOf(item, "agentLineOrRule"))];
    rows.push({ pieces, say: pieces });
  }
  return rows;
}

function segmentRows(): Row[] {
  return [
    line("Notes for contractor leads, the main kind of lead."),
    ...sectionsNumbered(10).flatMap((s) =>
      s.items.map((item) => {
        const pieces = [b("- "), ...tagLegal(bodyOf(item, "note"))];
        return { pieces, say: pieces } satisfies Row;
      }),
    ),
  ];
}

function personalityRows(profile: PersonalityProfile): Row[] {
  const t = profile.tempo;
  const rows: string[] = [
    profile.summary,
    "### Tone",
    ...profile.tone.map((x) => `- ${x}`),
    "### Tempo",
    `- At most ${t.maxSentencesPerTurn} ${t.maxSentencesPerTurn === 1 ? "sentence" : "sentences"} per turn. Aim for about ${t.targetWordsPerTurn} words and never more than ${t.maxWordsPerTurn}.`,
    `- ${t.pauseAfterQuestion}`,
    ...(t.matchCallerPace ? ["- Match the caller's pace. A flat or businesslike reply means shorter turns."] : []),
    `- If the caller sounds rushed: ${t.rushedCallerRule}`,
    "### Words",
    ...profile.vocabulary.prefer.map((p) => `- Say ${p.say}${p.insteadOf?.length ? `, not ${p.insteadOf.join(", ")}` : ""}.`),
    `- Never use these words: ${profile.vocabulary.avoid.map((a) => (a.say ? `${a.term} (say ${a.say})` : a.term)).join(", ")}.`,
    `- Never say: ${profile.avoidFillers.map((f) => `"${f}"`).join(", ")}. Never call the caller sir or ma'am; use the first name.`,
    "### Rapport",
    ...profile.rapport.map((x) => `- ${x}`),
  ];
  return rows.map((text) => ({ pieces: [b(text)], say: undefined }));
}

function factsRows(env: Env): Row[] {
  const { ctx } = env;
  const rows: string[] = [`This is an ${ctx.direction} call.`];
  const known = knownFacts(ctx);
  if (known.length) rows.push(...known.map((f) => `- ${f.label}: ${f.value}`));
  if (ctx.language === "es") rows.push("- preferred language: Spanish");
  const missing = missingFactKeys(ctx);
  rows.push(
    missing.length
      ? `Not on file: ${missing.map((k) => FACT_LABELS[k]).join("; ")}.`
      : "Every fact this call needs is on file.",
  );
  rows.push(
    "Never guess a missing fact and never say a line that needs it. Where a line below shows text in square brackets that you cannot fill from these facts or from what the caller has told you, skip the line or ask the caller.",
  );
  const notes = redactPriorNotes(ctx.priorNotes).slice(-5);
  if (notes.length) {
    rows.push("Notes from earlier calls, for continuity only. Never bring up anything sensitive:");
    rows.push(...notes.map((n) => `- ${n}`));
  }
  return rows.map(line);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const LAYER_TITLES: Record<PromptLayerId, string> = {
  identity: "Who you are",
  rules: "Rules",
  disclosure: "Opening line and disclosures",
  flow: "Call flow",
  openers: "Openers",
  gatekeepers: "Gatekeepers",
  discovery: "Discovery questions",
  objections: "Objections and questions for the producer",
  booking: "Booking and handoff",
  followup: "Follow-up messages",
  segment: "Contractors",
  personality: "How you sound",
  facts: "Facts on file",
};

export function renderLayer(layer: PromptLayerId, env: Env): RenderedSection | undefined {
  switch (layer) {
    case "identity":
      return finish(layer, LAYER_TITLES[layer], identityRows(env), env);
    case "rules":
      return finish(layer, LAYER_TITLES[layer], rulesRows(), env);
    case "disclosure":
      return finish(layer, LAYER_TITLES[layer], disclosureRows(env), env);
    case "flow":
      return finish(layer, LAYER_TITLES[layer], flowRows(env), env);
    case "openers":
      return finish(layer, LAYER_TITLES[layer], openersRows(), env);
    case "gatekeepers":
      return finish(layer, LAYER_TITLES[layer], gatekeeperRows(), env);
    case "discovery":
      return finish(layer, LAYER_TITLES[layer], discoveryRows(), env);
    case "objections":
      return finish(layer, LAYER_TITLES[layer], objectionRows(), env);
    case "booking":
      return finish(layer, LAYER_TITLES[layer], bookingRows(), env);
    case "followup":
      return finish(layer, LAYER_TITLES[layer], followupRows(), env);
    case "segment":
      return finish(layer, LAYER_TITLES[layer], segmentRows(), env);
    case "personality":
      if (!env.profile) return undefined;
      return finish(layer, `${LAYER_TITLES[layer]}: ${env.profile.label}`, personalityRows(env.profile), env);
    case "facts":
      return finish(layer, LAYER_TITLES[layer], factsRows(env), env);
  }
}

export type { Env as RenderEnv, RenderedSection };
