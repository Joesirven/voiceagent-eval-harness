import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SortedEvent } from "../../../src/server/live-view-core.js";
import { getCallAudio, getCallAudioLevel, subscribeCallAudio } from "../../../src/server/voice/voice-client.js";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { orbState, type OrbState } from "@/lib/orb-state";

// three.js is large; the orb loads in its own chunk so the page itself stays light.
const Orb = lazy(() => import("@/components/ui/orb").then((m) => ({ default: m.Orb })));

/** The orb needs WebGL; where that is missing or fails, a plain circle stands in and the page keeps working. */
class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="size-8 rounded-full bg-primary/30" /> : this.props.children; }
}

// Speech loudness mostly sits well below 0.25, so the bars are scaled up to use the waveform's height.
const WAVEFORM_SENSITIVITY = 4;

/** One colour pair per state (darker, lighter): the brand teal at rest and while listening, warmer while thinking, blue while working, bright while talking. */
const COLORS: Record<Exclude<OrbState, null> | "idle", [string, string]> = {
  idle: ["#5f8f8a", "#a9c9c4"],
  listening: ["#1f7c74", "#7fd1c7"],
  thinking: ["#a8762a", "#f0cf84"],
  working: ["#3b5b8c", "#9fb8d8"],
  talking: ["#13907f", "#9ff0e2"],
};
const WORDS: Record<Exclude<OrbState, null>, string> = { listening: "listening", thinking: "thinking", working: "working on a tool or a step", talking: "talking" };

/**
 * The orb shows who is talking. The waveform shows the call's own audio (the caller audio being sent and the agent
 * audio being played), read from the microphone client; it is flat while the call is paused and absent with no call.
 */
export function CallOrb({ sorted, inCall }: { sorted: SortedEvent[]; inCall: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const { live, paused } = useSyncExternalStore(subscribeCallAudio, getCallAudio);
  const state = paused ? null : orbState(sorted, inCall, now);
  return (
    <div className="flex items-center gap-2" id="callOrb" data-state={inCall ? (paused ? "paused" : state ?? "idle") : "idle"} title={inCall ? (paused ? "Call paused" : `Agent: ${state ? WORDS[state] : "idle"}`) : "Idle: no call"}>
      <div className="size-8 shrink-0" aria-hidden="true">
        <OrbBoundary>
          <Suspense fallback={<div className="size-8 rounded-full bg-muted" />}>
            <Orb agentState={state} colors={COLORS[state ?? "idle"]} />
          </Suspense>
        </OrbBoundary>
      </div>
      {inCall && live && <LiveWaveform active={!paused} getLevel={getCallAudioLevel} sensitivity={WAVEFORM_SENSITIVITY} height={28} barWidth={2} barGap={1} barColor="#1f7c74" className="w-24" />}
    </div>
  );
}
