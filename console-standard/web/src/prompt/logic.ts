import type { Draft, PromptSetup } from "./types.js";

/** The layer that carries the legal opening script. It is never editable and never left out. */
export const DISCLOSURE_LAYER = "disclosure";

const ERROR_WORDS: Record<string, string> = {
  disclosure_locked: "The disclosure cannot be edited. It stays word for word from the template.",
  disclosure_missing: "The opening script for this direction is missing from the result, so nothing was saved or previewed. Undo the last edit that removed it.",
  setup_is_shipped: "Shipped setups are read only. Use Save as new to keep your changes under a new id.",
  setup_unknown: "That setup no longer exists. Reload the list and choose another.",
  lead_not_found: "No lead with that id was found. Check the lead id.",
  origin_not_allowed: "The server refused this page's address. Open the panel from the console address.",
  invalid_id: "The id must be lower case words joined by hyphens, for example friendly-short.",
  id_taken: "A setup with that id already exists.",
};

/** Plain-words sentence for a server error code (or a network failure). */
export function errorWording(code: string | undefined, status?: number): string {
  if (code && ERROR_WORDS[code]) return ERROR_WORDS[code];
  if (code === "network") return "The server could not be reached. Your edits are kept here; try again in a moment.";
  if (status === 404) return "The server does not have this route yet, or the item was not found.";
  if (status && status >= 500) return "The server had a problem. Your edits are kept here; try again.";
  return code ? `The server refused the request (${code.replace(/_/g, " ")}).` : "Something went wrong. Your edits are kept here.";
}

export const isKebabCase = (id: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 60;

export function draftFromSetup(setup: PromptSetup): Draft {
  return {
    label: setup.label,
    description: setup.description,
    layers: [...setup.layers],
    personalityId: setup.personalityId,
    notes: setup.notes ?? "",
    overrides: { ...setup.overrides },
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameMap = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** True when the draft differs from the saved setup (the unsaved changes marker). */
export function isDirty(draft: Draft, saved: PromptSetup | undefined): boolean {
  if (!saved) return false;
  const base = draftFromSetup(saved);
  return draft.label !== base.label || draft.description !== base.description || draft.personalityId !== base.personalityId
    || draft.notes !== base.notes || !sameList([...draft.layers].sort(), [...base.layers].sort()) || !sameMap(draft.overrides, base.overrides);
}

/** Sets a section's override; text equal to the default removes the override. */
export function setOverride(draft: Draft, layerId: string, text: string, defaultText: string): Draft {
  if (layerId === DISCLOSURE_LAYER) return draft;
  const overrides = { ...draft.overrides };
  if (text === defaultText) delete overrides[layerId]; else overrides[layerId] = text;
  return { ...draft, overrides };
}

export function resetOverride(draft: Draft, layerId: string): Draft {
  const overrides = { ...draft.overrides };
  delete overrides[layerId];
  return { ...draft, overrides };
}

/** Turns a layer on or off. The disclosure layer cannot be turned off. */
export function toggleLayer(draft: Draft, layerId: string, on: boolean, order: string[]): Draft {
  if (layerId === DISCLOSURE_LAYER) return draft;
  const set = new Set(draft.layers);
  if (on) set.add(layerId); else set.delete(layerId);
  set.add(DISCLOSURE_LAYER);
  return { ...draft, layers: order.filter((id) => set.has(id)) };
}

/** Body for the save and preview routes: the disclosure is always in the layers and never in the overrides. */
export function buildSetupBody(draft: Draft) {
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.overrides)) if (k !== DISCLOSURE_LAYER) overrides[k] = v;
  const layers = draft.layers.includes(DISCLOSURE_LAYER) ? [...draft.layers] : [...draft.layers, DISCLOSURE_LAYER];
  const body: { label: string; description: string; layers: string[]; personalityId: string; notes?: string; overrides: Record<string, string> } = {
    label: draft.label, description: draft.description, layers, personalityId: draft.personalityId, overrides,
  };
  if (draft.notes.trim()) body.notes = draft.notes;
  return body;
}

export const buildPreviewBody = (draft: Draft, lead: string, direction: string) =>
  ({ setup: buildSetupBody(draft), lead: lead.trim() || "lead-1", direction });

/** Debounce with a cancel handle, so a stale preview request is never sent after the panel closes. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (...args: A) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; fn(...args); }, ms); };
  call.cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return call;
}
