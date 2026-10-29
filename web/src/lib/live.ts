import { useSyncExternalStore } from "react";
import * as core from "../../../src/server/live-view-core.js";

// One shared view of the live event stream. Events are ordered by the shared live-view logic;
// the plain-language sentence the server sends with each event is kept beside it.
export const liveView = core.createView();
export const plainBySeq = new Map<number, string>();
export const connection = { state: "Connecting" as "Connecting" | "Live" | "Reconnecting" };

let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version += 1; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useLiveVersion = () => useSyncExternalStore(subscribe, () => version);

export function ingestFrame(data: string): void {
  const { event, plain } = JSON.parse(data);
  if (plain) plainBySeq.set(event.seq, plain);
  if (event.type === "voice_error") window.dispatchEvent(new Event("harness-refresh"));
  if (core.ingest(liveView, event)) bump();
}

export function connectEvents(): () => void {
  const source = new EventSource("/api/events");
  source.onopen = () => { connection.state = "Live"; bump(); };
  source.onerror = () => { connection.state = "Reconnecting"; bump(); };
  source.onmessage = (m) => ingestFrame(m.data);
  return () => source.close();
}
