import { useSyncExternalStore } from "react";
import { getCallTracks, subscribeCallTracks } from "../../../src/server/voice/voice-client.js";

export type CallTracks = { ready: boolean; caller: MediaStreamTrack | null; agent: MediaStreamTrack | null };

/**
 * The call's own audio tracks as the microphone client publishes them: the caller microphone track, the agent
 * tap track and whether the call is ready. No track exists outside a call. This never opens a microphone stream.
 */
export function useCallAudio(): CallTracks {
  return useSyncExternalStore(subscribeCallTracks, getCallTracks) as CallTracks;
}
