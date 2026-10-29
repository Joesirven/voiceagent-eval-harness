/**
 * Browser-relayed live session surface (Azure gpt-live-1 only).
 */

export type HarnessLiveSession = {
  start(): Promise<void>;
  stop(reason?: string): void;
  sendAudio(base64: string): void;
  bargeIn(): void;
  sendCallerText(text: string): Promise<void>;
  isEnded: boolean;
  /** The caller is waiting and the model has not answered: ask it once more to say its line now. */
  remind?(): void;
};
