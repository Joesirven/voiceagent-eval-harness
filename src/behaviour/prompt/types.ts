import type { CallOpening } from "../../compliance/disclosures.js";
import type { Direction, LegalBlocksMode } from "../types.js";

/** The prompt layers a setup can list, in the fixed order they appear in the built prompt. */
export const PROMPT_LAYERS = [
  "identity",
  "rules",
  "disclosure",
  "flow",
  "openers",
  "gatekeepers",
  "discovery",
  "objections",
  "booking",
  "followup",
  "segment",
  "personality",
  "facts",
] as const;

export type PromptLayerId = (typeof PROMPT_LAYERS)[number];

/** The facts one call is built from. Anything absent is left bracketed and listed as not on file. */
export interface PromptContext {
  direction: Direction;
  agencyName?: string;
  businessName?: string;
  contactName?: string;
  /** The policy renewal date. */
  xDate?: string;
  /** The carrier named on the public record. */
  carrier?: string;
  publishedNumber?: string;
  agreedCallTime?: string;
  /** Where the renewal date came from, as the lead record names it. */
  renewalSource?: string;
  language?: "en" | "es";
  /** Earlier call summaries. Redacted before they reach the prompt. */
  priorNotes?: string[];
  /** The producer's first name, for the disclosure sentence. */
  producerFirstName?: string;
  /**
   * The opening the harness fixed for this call (disclosure parts, and the
   * confirmation question for a known lead). Absent: made from the facts above.
   */
  opening?: CallOpening;
}

export interface PromptSetup {
  /** Kebab-case. */
  id: string;
  label: string;
  description: string;
  layers: PromptLayerId[];
  personalityId: string | "none";
  notes?: string;
  /** Replacement text for a layer's section. The disclosure layer can never be replaced. */
  overrides?: Partial<Record<PromptLayerId, string>>;
  /**
   * Shipped setups only: a markdown file in the data directory whose "## <layer id>"
   * sections become the overrides. Read when the registry loads; see overrides-file.ts.
   */
  overridesFile?: string;
}

export type SectionLayer = "behaviour" | "legal" | "mixed";

export interface BuiltSection {
  /** "floor" or a layer id. */
  id: string;
  title: string;
  layer: SectionLayer;
  chars: number;
}

export interface BuiltPrompt {
  text: string;
  setupId: string;
  /** The personality actually rendered, or "none". */
  personalityId: string;
  legalBlocks: LegalBlocksMode;
  sections: BuiltSection[];
  /** Characters divided by four, rounded up. */
  approxTokens: number;
  /** Names of the context fields that were not supplied (see MISSING_FACT_LABELS). */
  missingFacts: string[];
}

export interface BuildOptions {
  legalBlocks?: LegalBlocksMode;
  /** A personality id (or "none") that replaces the setup's own for this build. */
  personalityOverride?: string;
}
