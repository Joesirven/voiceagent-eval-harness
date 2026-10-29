/**
 * Builds the system prompt for a call from a setup and the facts of the call.
 * Deterministic: the same input gives the same text. Section order is fixed: the
 * safety floor first, then the layers in PROMPT_LAYERS order.
 */

import { effectiveLegalBlocks } from "../switches.js";
import { findPersonality, getPersonality } from "./personality.js";
import { renderFloor, renderLayer, type RenderEnv, type RenderedSection } from "./sections.js";
import { fillSlots, missingFactKeys } from "./slots.js";
import { isSpokenLine, quotedStrings } from "./text.js";
import { getPromptSetupRegistry, validateSetup } from "./setups.js";
import { PROMPT_LAYERS, type BuildOptions, type BuiltPrompt, type PromptContext, type PromptSetup } from "./types.js";

function resolveSetup(setup: string | PromptSetup): PromptSetup {
  if (typeof setup === "string") {
    const found = getPromptSetupRegistry().get(setup);
    if (!found) throw new Error(`setup_unknown:${setup}`);
    return found;
  }
  const errors = validateSetup(setup);
  if (errors.length) throw new Error(errors.join(","));
  return setup;
}

function renderAll(setup: PromptSetup, ctx: PromptContext, options: BuildOptions, applyOverrides = true) {
  const mode = effectiveLegalBlocks(options.legalBlocks);
  const requested = options.personalityOverride ?? setup.personalityId;
  if (requested !== "none" && !findPersonality(requested)) throw new Error(`personality_unknown:${requested}`);
  const wantsPersonality = setup.layers.includes("personality") && requested !== "none";
  const profile = wantsPersonality ? getPersonality(requested) : undefined;
  const env: RenderEnv = { ctx, mode, profile };
  const sections: RenderedSection[] = [renderFloor(env)];
  for (const layer of PROMPT_LAYERS) {
    if (!setup.layers.includes(layer)) continue;
    const rendered = renderLayer(layer, env);
    if (!rendered) continue;
    const override = layer === "disclosure" || !applyOverrides ? undefined : setup.overrides?.[layer];
    if (typeof override === "string") {
      // The override is the section's body; it keeps the section's own heading so every section reads the same way.
      const body = override.startsWith("## ") ? override : `## ${rendered.title}\n${override}`;
      const text = fillSlots(body, ctx);
      sections.push({ ...rendered, text, say: quotedStrings(text).filter(isSpokenLine) });
    } else {
      sections.push(rendered);
    }
  }
  return { sections, mode, profile };
}

export function buildSystemPrompt(setup: string | PromptSetup, ctx: PromptContext, options: BuildOptions = {}): BuiltPrompt {
  const resolved = resolveSetup(setup);
  const { sections, mode, profile } = renderAll(resolved, ctx, options);
  const text = sections.map((s) => s.text).join("\n\n");
  return {
    text,
    setupId: resolved.id,
    personalityId: profile?.id ?? "none",
    legalBlocks: mode,
    sections: sections.map((s) => ({ id: s.id, title: s.title, layer: s.layer, chars: s.text.length })),
    approxTokens: Math.ceil(text.length / 4),
    missingFacts: missingFactKeys(ctx),
  };
}

/** The quoted example lines the prompt tells the agent to say, for checking them against the speech guard. */
export function collectSpokenLines(setup: string | PromptSetup, ctx: PromptContext, options: BuildOptions = {}): string[] {
  const resolved = resolveSetup(setup);
  const { sections } = renderAll(resolved, ctx, options);
  return [...new Set(sections.flatMap((s) => s.say))];
}

export interface SetupComparison {
  setupId: string;
  personalityId: string;
  approxTokens: number;
  sectionChars: Record<string, number>;
}

/** Side-by-side sizes of several setups for the same call, for choosing between them. */
export function compareSetups(setupIds: string[], ctx: PromptContext, options: BuildOptions = {}): SetupComparison[] {
  return setupIds.map((id) => {
    const built = buildSystemPrompt(id, ctx, options);
    return {
      setupId: built.setupId,
      personalityId: built.personalityId,
      approxTokens: built.approxTokens,
      sectionChars: Object.fromEntries(built.sections.map((s) => [s.id, s.chars])),
    };
  });
}

export interface SetupSection {
  id: string;
  title: string;
  /** The section as this setup renders it, with its override applied. */
  text: string;
  /** The same section without the setup's override. */
  defaultText: string;
  overridden: boolean;
}

/** Each section of a setup for the given facts. With no facts supplied the bracketed slots stay as templates. */
export function renderSetupSections(setup: string | PromptSetup, ctx: PromptContext, options: BuildOptions = {}): SetupSection[] {
  const resolved = resolveSetup(setup);
  const plain = renderAll(resolved, ctx, options, false).sections;
  const applied = renderAll(resolved, ctx, options, true).sections;
  return applied.map((s, i) => ({
    id: s.id,
    title: s.title,
    text: s.text,
    defaultText: plain[i]?.text ?? s.text,
    overridden: s.text !== (plain[i]?.text ?? s.text),
  }));
}
