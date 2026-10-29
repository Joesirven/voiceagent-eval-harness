export { buildLeadContext, buildLeadContextJson, leadContextGateOn, renderUpdateText, renderFullText, updateFingerprint, CONFIRMATION_GATE } from "./build.js";
export { createContextUpdater, stepIsConfirmed, updateBodyFor, UPDATE_HEADING, type ContextUpdater, type ContextUpdaterOptions } from "./live-update.js";
export { callerLineConfirms, confirmationNames, type CallerLineVerdict } from "./confirmation.js";
export { computeRenewal, parseCalendarDate } from "./renewal.js";
export { stageInfo, STAGE_MEANINGS } from "./stage.js";
export { buildChecklist, QUOTE_FIELD_LABELS } from "./checklist.js";
export { buildFacts } from "./facts.js";
export { defaultAgencyName, handleLeadContextRoute, leadContextRouteDeps } from "./route.js";
export * from "./types.js";
