/**
 * Agency feature flag. Talk starts on for the demo agency every time this
 * process boots. Any other agency stays off until switched on.
 * Voice module settings live in the module registry, not here.
 */

export type LeadStoreKind = "mock";

/**
 * The one test-mode switch. "enforced" runs every legal block. "suspended" skips
 * exactly: consent, artificial-voice consent, quiet hours, do-not-call and the
 * store's last reach check, each shown in the trace as skipped. The library
 * default is "enforced"; only the local development server starts "suspended".
 */
export type LegalBlocks = "enforced" | "suspended";

export interface HarnessConfig {
  /** Demo agency used by fixtures and the control page. */
  agencyId: string;
  /** Per-agency AI-calling flag. An agency absent from the map is off. */
  aiCallingByAgency: Record<string, boolean>;
  /** The mock store is the only built-in store. */
  leadStoreKind: LeadStoreKind;
  /** See LegalBlocks. Read once at the start of each call or text, never mid-run. */
  legalBlocks: LegalBlocks;
  /**
   * Only meaningful while suspended: duplicate-call keys and the two-attempt
   * counter are scoped to this id, so the same development lead can be replayed
   * by starting a new session.
   */
  testSessionId: string;
  /**
   * The one test phone number test mode may reach. Absent means browser and simulated lines only.
   */
  testPhone?: string;
  /** The prompt setup in force, recorded with every harness run. Set by the behaviour-layers module. */
  promptSetupId: string;
  /**
   * Whether the opening says the recording sentence (INBOUND_RECORDING_DISCLOSURE)
   * after the artificial intelligence sentence. Read once at the start of each call.
   */
  recordingNoticeEnabled: boolean;
  /**
   * Who every call's opening names, overriding the lead record's producer and agency. Absent (the library
   * default) means the lead record's own; the local development server sets the fictional demo identity.
   */
  openingIdentity?: OpeningIdentity;
  /**
   * When true, a Talk call skips the compliance gates at call start and the
   * after-call disclosure check, and records one compliance_check row saying so.
   */
  complianceChecksOff?: boolean;
  /**
   * When true, flow tools run without the action judge, the evidence-quote
   * check or the store evidence rule.
   */
  actionJudgeOff?: boolean;
}

/** The producer and agency a call's opening names. */
export interface OpeningIdentity {
  producerFirstName: string;
  agencyName: string;
}

export const DEMO_OPENING: Readonly<OpeningIdentity> = Object.freeze({ producerFirstName: "Dana", agencyName: "Northwind Insurance Agency" });

/**
 * How the opening names the agent, in one place. The compliance checks look for the literal words "AI assistant"
 * (src/compliance/disclosures.ts), so change these only together with those checks. The prior design used "voice assistant"
 * on 2026-10-21; "AI assistant" stays until he decides.
 */
export const ASSISTANT_WORDS = "AI assistant";

/**
 * Reference voice stack defaults: Twilio media streams into one Azure
 * realtime session per call. Other vendor backends stay off in the harness.
 */
export interface VoiceStackConfig {
  twilioMediaStreams: boolean;
  azureRealtime: boolean;
  realtimeBackend: "azure";
  openaiRealtime: boolean;
  retell: boolean;
  vapi: boolean;
  elevenLabsAgents: boolean;
  bland: boolean;
  fishAudio: boolean;
  sesame: boolean;
}

export const defaultVoiceStack: VoiceStackConfig = {
  twilioMediaStreams: true,
  azureRealtime: true,
  realtimeBackend: "azure",
  openaiRealtime: false,
  retell: false,
  vapi: false,
  elevenLabsAgents: false,
  bland: false,
  fishAudio: false,
  sesame: false,
};

export const defaultConfig: HarnessConfig = {
  agencyId: "agency-demo",
  aiCallingByAgency: { "agency-demo": true },
  leadStoreKind: "mock",
  legalBlocks: "enforced",
  testSessionId: "test-session-1",
  promptSetupId: "default",
  // Prototype setting. Turn this on before a real caller is put through.
  recordingNoticeEnabled: false,
};

let activeConfig: HarnessConfig = cloneDefault();

function cloneDefault(): HarnessConfig {
  return { ...defaultConfig, aiCallingByAgency: { ...defaultConfig.aiCallingByAgency } };
}

export function getHarnessConfig(): HarnessConfig {
  return activeConfig;
}

export function isAiCallingEnabled(agencyId: string): boolean {
  return activeConfig.aiCallingByAgency[agencyId] === true;
}

/** Takes effect on the very next call; nothing is cached. */
export function setAiCallingEnabled(agencyId: string, enabled: boolean): void {
  activeConfig.aiCallingByAgency = { ...activeConfig.aiCallingByAgency, [agencyId]: enabled };
}

export function setLeadStoreKind(kind: LeadStoreKind): void {
  activeConfig.leadStoreKind = kind;
}

export function setLegalBlocks(mode: LegalBlocks): void {
  activeConfig.legalBlocks = mode;
}

export function setTestSessionId(id: string): void {
  if (!/^[\w-]{1,40}$/.test(id)) throw new Error("bad_test_session_id");
  activeConfig.testSessionId = id;
}

/** Stored as given; the clearance compares it by its last ten digits. */
export function setTestPhone(phone: string | undefined): void {
  activeConfig.testPhone = phone;
}

export function setPromptSetupId(id: string): void {
  activeConfig.promptSetupId = id;
}

/** Takes effect on the very next call. */
export function setRecordingNoticeEnabled(enabled: boolean): void {
  activeConfig.recordingNoticeEnabled = enabled;
}

/** Takes effect on the very next tool call. */
export function setActionJudgeOff(off: boolean): void {
  activeConfig.actionJudgeOff = off;
}

/** Takes effect on the very next call. */
export function setComplianceChecksOff(off: boolean): void {
  activeConfig.complianceChecksOff = off;
}

/** Takes effect on the very next call; undefined goes back to the lead record's own producer and agency. */
export function setOpeningIdentity(identity: OpeningIdentity | undefined): void {
  activeConfig.openingIdentity = identity ? { ...identity } : undefined;
}

export function resetHarnessConfig(): void {
  activeConfig = cloneDefault();
}
