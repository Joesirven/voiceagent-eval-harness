/** Mock bidirectional Twilio Media Streams: one session per call, clear on barge-in. */

export interface TwilioStreamSession {
  streamSid: string;
  callSid: string;
  playbackQueue: string[];
  cleared: boolean;
}

const sessions = new Map<string, TwilioStreamSession>();

export function twilioConnectStream(callId: string): TwilioStreamSession {
  const session: TwilioStreamSession = {
    streamSid: `MZ${callId}`,
    callSid: `CA${callId}`,
    playbackQueue: [],
    cleared: false,
  };
  sessions.set(callId, session);
  return session;
}

export function twilioEnqueuePlayback(callId: string, audioToken: string): void {
  const s = sessions.get(callId);
  if (!s) return;
  s.playbackQueue.push(audioToken);
}

export function twilioClearOnBargeIn(callId: string): void {
  const s = sessions.get(callId);
  if (!s) return;
  s.playbackQueue = [];
  s.cleared = true;
}

export function twilioEndStream(callId: string): void {
  sessions.delete(callId);
}
