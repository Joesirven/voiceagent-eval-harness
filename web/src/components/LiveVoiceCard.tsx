import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { bindLeadVoice } from "../../../src/server/voice/voice-client.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const NATIVE = "h-8 w-44 min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
// The microphone client writes its status here; these are the messages that mean something went wrong.
const FAILURE = /^(Microphone (failed|blocked)|Voice error|Call not started|WebSocket|Voice relay)/;

/**
 * The live voice call controls. Element ids are kept because the shared microphone client (voice-client.js)
 * finds its elements by id and fills the lead list, status, clock and hint itself.
 */
export function LiveVoiceCard({ onCall, inCall, settings, setup, orb }: {
  onCall: (callId: string | null) => void; inCall: boolean; settings?: ReactNode;
  /** The call setup dialog with its own Play button; when given, Play opens it and the dialog's Go starts the call. */
  setup?: ReactNode; orb?: ReactNode;
}) {
  const [direction, setDirection] = useState("inbound");

  useEffect(() => {
    // Every microphone or voice failure also pops up as a toast. Watchers go first so the first hint is seen.
    let last = "";
    const watch = (id: string, isHint: boolean) => {
      const node = document.getElementById(id);
      if (!node) return () => {};
      const observer = new MutationObserver(() => {
        const text = node.textContent?.trim() ?? "";
        if (text && text !== last && (isHint ? node.classList.contains("err") : FAILURE.test(text))) {
          last = text;
          toast.error(text);
        }
      });
      observer.observe(node, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    };
    const stops = [watch("playVoiceStatus", false), watch("playMicHint", true)];
    bindLeadVoice({
      lead: "playLead", dir: "playDir", startMic: "playTalk", hang: "playVoiceEnd", pause: "playPause", gap: "playGap",
      status: "playVoiceStatus", clock: "playClock", micHint: "playMicHint",
    }, { onCall });
    return () => stops.forEach((s) => s());
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-3 py-1.5">
      <div className={cn("flex items-center gap-2", inCall && "hidden")} id="callSetup">
        <Label htmlFor="playLead" className="sr-only">Lead</Label>
        <select id="playLead" aria-label="Lead" title="Which lead the call is about" className={NATIVE} />
        <input type="hidden" id="playDir" value={direction} readOnly />
        <ToggleGroup type="single" size="sm" variant="outline" value={direction} aria-label="Direction"
          onValueChange={(v) => v && setDirection(v)}>
          <ToggleGroupItem value="inbound" className="h-8 px-2 text-xs" title="The lead calls us">Inbound</ToggleGroupItem>
          <ToggleGroupItem value="outbound" className="h-8 px-2 text-xs" title="We call the lead">Outbound</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <input type="hidden" id="playGap" value="900" readOnly />
      <div className="flex items-center gap-1.5">
        {setup}
        {/* The microphone client starts the call from this button; with the setup dialog it stays bound but hidden, and Go starts the call. */}
        <Button id="playTalk" size="icon" className={cn("size-8", setup ? "hidden" : undefined)} aria-hidden={setup ? true : undefined} tabIndex={setup ? -1 : undefined}
          aria-label={setup ? "Start the call now" : "Play: start a live voice call"} title="A live voice call through the selected orchestrator, with the decision tree and judge behind it."><PlayIcon /></Button>
        <Button id="playPause" size="icon" className="size-8 data-[paused=true]:border-amber-500 data-[paused=true]:bg-amber-100" variant="outline" aria-label="Pause or resume the call" title="Pause: hold the microphone and the agent's speech. Press again to resume." aria-pressed="false" disabled><PauseIcon /></Button>
        <Button id="playVoiceEnd" size="icon" className="size-8" variant="outline" aria-label="End the call" title="End the call" disabled><SquareIcon /></Button>
        {!inCall && settings}
      </div>
      {orb}
      <span id="playVoiceStatus" role="status" className="text-xs text-muted-foreground" />
      <span id="playClock" className="text-xs text-muted-foreground" />
      <p id="playMicHint" className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground [&.err]:text-destructive" />
    </div>
  );
}
