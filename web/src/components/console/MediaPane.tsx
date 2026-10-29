import { useEffect, useState, type ReactNode } from "react";
import type { SortedEvent } from "../../../../src/server/live-view-core.js";
import { AudioVisualizerRadialView } from "@/components/pipecat/audio-visualizer-radial";
import { AudioVisualizerWaveView } from "@/components/pipecat/audio-visualizer-wave";
import { ConsolePanel, ConsolePanelContent, ConsolePanelHeader, ConsolePanelTitle } from "@/components/console/panel";
import { useCallAudio } from "@/lib/use-call-audio";
import { orbState } from "@/lib/orb-state";

/**
 * The media pane: a wave on the agent audio, a radial ring on the caller audio, and the call controls underneath.
 * Both visualizers read the call's own published tracks. The agent shows thinking while a decision is landing, and
 * both show connecting from the start of a call until it is ready.
 */
export function MediaPane({ sorted, inCall, controls }: { sorted: SortedEvent[]; inCall: boolean; controls: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!inCall) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [inCall]);
  const { ready, caller, agent } = useCallAudio();
  const connecting = inCall && !ready;
  // The caller track appears a moment after the call is ready, once the microphone is open.
  const callerConnecting = inCall && (!ready || caller === null);
  const thinking = orbState(sorted, inCall, now) === "thinking";
  return (
    <ConsolePanel id="consoleMedia">
      <ConsolePanelHeader>
        <ConsolePanelTitle>Media</ConsolePanelTitle>
      </ConsolePanelHeader>
      <ConsolePanelContent className="flex flex-col gap-2">
        {inCall ? (
          <div className="flex flex-wrap items-center justify-around gap-2">
            <figure className="flex flex-col items-center gap-0.5" data-testid="agentVisualizer">
              <AudioVisualizerWaveView track={agent} size={120} isConnecting={connecting} isThinking={!connecting && thinking} />
              <figcaption className="text-xs text-muted-foreground">Agent</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-0.5" data-testid="callerVisualizer">
              <AudioVisualizerRadialView track={caller} isConnecting={callerConnecting} />
              <figcaption className="text-xs text-muted-foreground">Caller</figcaption>
            </figure>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="mediaIdle">No call is running. The agent and caller sound shows here once a call starts.</p>
        )}
        <div data-testid="mediaControls">{controls}</div>
      </ConsolePanelContent>
    </ConsolePanel>
  );
}
