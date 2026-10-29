/** Shapes of the prompt setup routes, as agreed in the contract with the server. */
export interface PromptSetup {
  id: string;
  label: string;
  description: string;
  shipped: boolean;
  layers: string[];
  personalityId: string;
  notes?: string;
  overrides: Record<string, string>;
}
export interface LayerInfo { id: string; title: string; editable: boolean }
export interface PersonalityInfo { id: string; label: string }
export interface DisclosureInfo { text: string; locked: true; note: string }
export interface SetupsResponse {
  setups: PromptSetup[];
  selectedId: string;
  layers: LayerInfo[];
  personalities: PersonalityInfo[];
  disclosure: DisclosureInfo;
}
export interface SectionInfo { id: string; title: string; editable: boolean; text: string; defaultText: string; overridden: boolean }
export type Direction = "inbound" | "outbound";

/** The editable copy of a setup held in the panel: everything the save route accepts. */
export interface Draft {
  label: string;
  description: string;
  layers: string[];
  personalityId: string;
  notes: string;
  overrides: Record<string, string>;
}
export interface PreviewResult { text: string; approxTokens: number }
