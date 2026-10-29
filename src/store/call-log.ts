export type CallLogOutcome =
  | "placed"
  | "answered"
  | "skipped"
  | "blocked"
  | "ended"
  | "message_sent"
  | "message_blocked";

export interface CallLogEntry {
  at: string;
  leadId: string;
  callId?: string;
  /** Key the harness derived and claimed. */
  idempotencyKey?: string;
  /** Key the caller or webhook supplied, kept for tracing. */
  requestKey?: string;
  direction?: "inbound" | "outbound";
  channel: "call" | "sms";
  outcome: CallLogOutcome;
  reason: string;
}

const entries: CallLogEntry[] = [];

export function logCommunication(entry: Omit<CallLogEntry, "at">): CallLogEntry {
  const row: CallLogEntry = { ...entry, at: new Date().toISOString() };
  entries.push(row);
  return row;
}

export function getCallLogs(): CallLogEntry[] {
  return [...entries];
}

export function clearCallLogs(): void {
  entries.length = 0;
}
