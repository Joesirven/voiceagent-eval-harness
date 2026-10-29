/**
 * A STOP spoken or texted in test mode. It is recorded locally (here, in the
 * trace and in the call's handoff note) and in the harness table, and it is
 * never sent through an external lead-store function: that could revoke the lead for
 * the whole team. Inside one test session the lead is not contacted again; a new
 * test session starts clean, so the same development lead can be replayed.
 */

export interface TestStop {
  leadId: string;
  sessionId: string;
  callId: string;
  source: "voice_call" | "text";
  matched: string;
  occurredAt: string;
}

const stops: TestStop[] = [];

export function recordTestStop(stop: TestStop): void {
  stops.push({ ...stop });
}

export function hasTestStop(sessionId: string, leadId: string): boolean {
  return stops.some((s) => s.sessionId === sessionId && s.leadId === leadId);
}

export function getTestStops(): TestStop[] {
  return stops.map((s) => ({ ...s }));
}

export function clearTestStops(): void {
  stops.length = 0;
}
