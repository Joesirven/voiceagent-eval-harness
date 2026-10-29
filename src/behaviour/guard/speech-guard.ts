// Placeholder so dependent modules compile. Replaced by the speech guard implementation.
import type { Finding, GuardContext, GuardResult } from "../types.js";

export const ROLE_LIMIT_LINE =
  "I'm not a licensed producer, so I can't go over price or coverage. A licensed producer can, and I can book that call now.";

export function checkAgentLine(_text: string, _ctx: GuardContext): Finding[] {
  return [];
}

export function guardAgentLine(text: string, ctx: GuardContext): GuardResult {
  const findings = checkAgentLine(text, ctx);
  return { allowed: findings.length === 0, spokenText: text, findings };
}
