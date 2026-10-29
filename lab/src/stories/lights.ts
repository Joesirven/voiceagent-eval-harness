/**
 * Traffic lights for the tree: every step and every answer coloured by where
 * it is heading. Forward endings (a booking, a callback, a handoff, a message)
 * are the good road, a fizzle is the unsure road, and a no or a stop is heading
 * to a no. Because a no is always nearer than a booking (one firm "no" ends any
 * call, a booking takes several answers), "nearest ending" alone would paint the
 * whole opening red; the rule here is: red when the very next answer can end
 * the call as a no, green when a good ending is within `GOOD_REACH` answers,
 * amber otherwise. The counters show the raw distances for every kind.
 * Follow-up ("_more") nodes count as their parent.
 *
 * Two readings keep the colours honest: an answer that books or transfers on
 * the spot counts as reaching that ending, and the step that only files the
 * outcome ("Record how the call ended") is neutral, because it reaches every
 * ending in one move and would colour the whole close as a tie.
 */
import { choicesAt, indexTree, isFollowUp, parentOf, type LabTree } from "./walk.js";

export type Light = "good" | "unsure" | "no";

export const ENDING_KIND: Record<string, Light> = {
  booked: "good",
  callback: "good",
  handed_off: "good",
  message_taken: "good",
  talked: "unsure",
  hung_up: "unsure",
  no_answer: "unsure",
  not_interested: "no",
  soft_declined: "no",
  wrong_number: "no",
  declined_ai_or_recording: "no",
  do_not_contact: "no",
  compliance_review: "no",
};

export const LIGHT_WORDS: Record<Light, { word: string; glyph: string; color: string }> = {
  good: { word: "good road", glyph: "✓", color: "#2E7D4F" },
  unsure: { word: "unsure road", glyph: "~", color: "#B7791F" },
  no: { word: "heading to a no", glyph: "✕", color: "#B23A3A" },
};

/** A good ending this many answers away, or fewer, still counts as the good road. */
export const GOOD_REACH = 5;

/** The step that files the outcome already decided elsewhere; it seeds nothing. */
const NEUTRAL_NODES = new Set(["close.final_disposition"]);

export interface NodeLights {
  /** Steps to the nearest ending of each kind, or null when none is reachable. */
  distance: Record<Light, number | null>;
  /** Red when one answer can end the call as a no, green when a good ending is within reach, amber otherwise. */
  light: Light;
}

/** Breadth-first distances from every real step to the nearest ending of each kind. */
export function computeLights(tree: LabTree): Map<string, NodeLights> {
  const byId = indexTree(tree);
  const real = tree.nodes.filter((n) => !isFollowUp(n.id)).map((n) => n.id);
  // Reverse edges, ending-kind seeds, then one breadth-first search per kind.
  const back = new Map<string, Set<string>>();
  const seeds: Record<Light, Set<string>> = { good: new Set(), unsure: new Set(), no: new Set() };
  for (const id of real) {
    for (const c of choicesAt(byId, id)) {
      if (!c.to) continue;
      if (c.commits) seeds[ENDING_KIND[c.commits] ?? "good"].add(id);
      if (c.ends) {
        const kind = ENDING_KIND[c.to];
        if (kind && !NEUTRAL_NODES.has(id)) seeds[kind].add(id);
      } else {
        const to = parentOf(c.to);
        if (!back.has(to)) back.set(to, new Set());
        back.get(to)!.add(id);
      }
    }
  }
  const distances: Record<Light, Map<string, number>> = { good: new Map(), unsure: new Map(), no: new Map() };
  for (const kind of ["good", "unsure", "no"] as Light[]) {
    const queue: Array<readonly [string, number]> = [...seeds[kind]].map((id) => [id, 1] as const);
    for (const [id, d] of queue) {
      if (distances[kind].has(id)) continue;
      distances[kind].set(id, d);
      for (const from of back.get(id) ?? []) if (!distances[kind].has(from)) queue.push([from, d + 1]);
    }
  }
  const out = new Map<string, NodeLights>();
  for (const id of real) {
    const distance: Record<Light, number | null> = {
      good: distances.good.get(id) ?? null,
      unsure: distances.unsure.get(id) ?? null,
      no: distances.no.get(id) ?? null,
    };
    out.set(id, { distance, light: lightFor(distance) });
  }
  return out;
}

function lightFor(distance: Record<Light, number | null>): Light {
  const good = distance.good ?? Infinity;
  if (distance.no === 1 && good > 1) return "no";
  if (distance.unsure === 1 && good > 2) return "unsure"; // the call can fizzle on the next answer
  if (good <= GOOD_REACH) return "good";
  return "unsure";
}

/** The light for one answer: an ending's own kind, or the light of the step it leads to. */
export function lightOfChoice(lights: Map<string, NodeLights>, to: string | undefined, ends: boolean | undefined, commits?: string): Light {
  if (commits) return ENDING_KIND[commits] ?? "good";
  if (!to) return "unsure";
  if (ends) return ENDING_KIND[to] ?? "unsure";
  return lights.get(parentOf(to))?.light ?? "unsure";
}
