/** Mock Azure OpenAI realtime speech-to-speech session. */

import type { LeadContextPacket } from "../memory/context.js";

export interface RealtimeSession {
  sessionId: string;
  backend: "azure" | "openai";
  connected: boolean;
  contextPacket?: LeadContextPacket;
}

const sessions = new Map<string, RealtimeSession>();
const contextArchive = new Map<string, LeadContextPacket>();

export function azureCreateSession(callId: string, contextPacket?: LeadContextPacket): RealtimeSession {
  const existing = sessions.get(callId);
  if (existing) {
    if (contextPacket) existing.contextPacket = contextPacket;
    return existing;
  }
  const session: RealtimeSession = {
    sessionId: `azure_${callId}`,
    backend: "azure",
    connected: true,
    contextPacket,
  };
  sessions.set(callId, session);
  return session;
}

export function azureGetContextPacket(callId: string): LeadContextPacket | undefined {
  return sessions.get(callId)?.contextPacket ?? contextArchive.get(callId);
}

export function azureCloseSession(callId: string): void {
  const s = sessions.get(callId);
  if (s) {
    s.connected = false;
    if (s.contextPacket) {
      contextArchive.set(callId, s.contextPacket);
    }
  }
  sessions.delete(callId);
}
