/// <reference types="vite/client" />

// The microphone client is a plain browser module shared with the standalone voice page.
declare module "*/voice-client.js" {
  export function bindLeadVoice(
    ids: Record<string, string>,
    options?: { onCall?: (callId: string | null) => void },
  ): void;
  /** Low-pass filter plus decimation; carries filter history and read position across frames. */
  export function createDownsampler(inputRate: number, outputRate?: number): (frame: Float32Array) => Float32Array;
  /** Whether a call is live and whether it is paused; a new object each time either changes. */
  export function getCallAudio(): { live: boolean; paused: boolean };
  export function subscribeCallAudio(listener: () => void): () => void;
  /** Loudness from 0 to 1 of the caller audio being sent or the agent audio being played; zero while paused or with no call. */
  export function getCallAudioLevel(): number;
  /** The call's own audio tracks and whether the call is ready; a new object each time something is published. */
  export function getCallTracks(): { ready: boolean; caller: MediaStreamTrack | null; agent: MediaStreamTrack | null };
  export function subscribeCallTracks(listener: () => void): () => void;
  /**
   * Starts a microphone call on the most recently bound controls, as clicking their startMic button would; does nothing
   * with no controls bound or while a call is starting or live. With ring, a ringback plays at once and the call starts
   * ringLeadMs later (default 1500); the ring stops at the first agent audio, when the call ends or fails, on the next
   * call to this function, or after 30 seconds.
   */
  export function startBoundCall(options?: { ring?: boolean; ringLeadMs?: number }): void;
  /** Whether the ringback is playing; not pushed to listeners, so read it when the page renders. */
  export function isRinging(): boolean;
}
