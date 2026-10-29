import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ConversationPane } from "@/components/console/ConversationPane";
import { JudgesPane } from "@/components/console/JudgesPane";
import { MediaPane } from "@/components/console/MediaPane";
import { MetricsPane } from "@/components/console/MetricsPane";
import { ObjectivesPane } from "@/components/console/ObjectivesPane";
import { useMinWidth } from "@/components/console/panel";
import { LiveVoiceCard } from "@/components/LiveVoiceCard";
import { SettingsSheet } from "@/components/SettingsSheet";
import { CallSetupDialog } from "@/components/CallSetupDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLayout } from "@/lib/layout";
import { plainBySeq, useLiveVersion } from "@/lib/live";
import type { AppState } from "@/lib/types";
import { useCallView } from "@/lib/use-call-view";
import { cn } from "@/lib/utils";

const WIDE_BREAKPOINT = 1024;
const NARROW_TABS = [
  { value: "call", label: "Call" },
  { value: "conversation", label: "Conversation" },
  { value: "metrics", label: "Metrics" },
  { value: "objectives", label: "Objectives" },
  { value: "judges", label: "Judges" },
] as const;

const plainSentence = (e: { seq: number }) => plainBySeq.get(e.seq);

/**
 * Where the call controls sit in the current layout. The controls live in one element that is created once and
 * moved into whichever slot is on screen, so crossing the width breakpoint never remounts the call controls
 * (the voice client holds on to their elements).
 */
function ControlsSlot({ host }: { host: HTMLElement }) {
  const attach = useCallback((slot: HTMLDivElement | null) => { if (slot && host.parentNode !== slot) slot.appendChild(host); }, [host]);
  return <div ref={attach} />;
}

/**
 * The console: the live call laid out in panes. Wide screens get a resizable
 * grid with a collapsible bottom pane; narrow screens get bottom tabs. The
 * right column holds the running metrics and the call's stage and objectives.
 */
export function VoiceAgentConsole({ state, refresh, inCall, onInCall }: {
  state: AppState;
  refresh: (s?: AppState) => Promise<void>;
  inCall: boolean;
  onInCall: (v: boolean) => void;
}) {
  useLiveVersion();
  const wide = useMinWidth(WIDE_BREAKPOINT);
  const model = useCallView();
  const outer = useLayout("console-outer");
  const main = useLayout("console-main");
  const right = useLayout("console-right");
  const bottomRef = useRef<PanelImperativeHandle | null>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const azureDown = state.azureStatus && !state.azureStatus.ok;
  const moduleDown = state.decisionModuleStatus && !state.decisionModuleStatus.available;

  const [host] = useState(() => document.createElement("div"));
  // The panes follow a Pipecat call as soon as it starts, as the Call tab does.
  useEffect(() => {
    const onStart = (e: Event) => { const id = (e as CustomEvent<{ callId: string }>).detail?.callId; if (id) { model.replay.stop(); model.setPinned(id); } };
    window.addEventListener("pipecat-call-started", onStart);
    return () => window.removeEventListener("pipecat-call-started", onStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const controlsCard = (
    <LiveVoiceCard
      inCall={inCall}
      settings={<SettingsSheet state={state} refresh={refresh} />}
      setup={<CallSetupDialog state={state} refresh={refresh} disabled={inCall} />}
      onCall={(callId) => {
        onInCall(Boolean(callId));
        if (callId) { model.replay.stop(); model.setPinned(callId); }
      }}
    />
  );

  const media = <MediaPane sorted={model.sorted} inCall={inCall} controls={<ControlsSlot host={host} />} />;
  const conversation = (
    <ConversationPane
      sorted={model.sorted} groups={model.groups} judged={model.judged} sum={model.sum}
      plain={plainSentence} replaying={model.replay.data !== null}
    />
  );
  const metrics = <MetricsPane model={model} />;
  const objectives = <ObjectivesPane model={model} />;
  const judges = <JudgesPane model={model} errors={state.voiceErrors ?? []} />;

  const toggleBottom = () => {
    const panel = bottomRef.current;
    if (!panel) return;
    if (bottomCollapsed) panel.expand(); else panel.collapse();
    setBottomCollapsed(!bottomCollapsed);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="voice-agent-console">
      {createPortal(controlsCard, host)}
      {(wide || azureDown || moduleDown) && <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-3 py-1">
        {(azureDown || moduleDown) && (
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {azureDown && (
              <Alert variant="destructive" role="alert" className="w-auto py-1">
                <AlertTitle className="text-xs">Azure is not working, so new calls are refused</AlertTitle>
                <AlertDescription className="text-xs">{state.azureStatus?.message ?? "Azure unavailable."}</AlertDescription>
              </Alert>
            )}
            {moduleDown && (
              <Alert variant="destructive" role="alert" className="w-auto py-1">
                <AlertTitle className="text-xs">Decision model unavailable</AlertTitle>
                <AlertDescription className="text-xs">{state.decisionModuleStatus?.message || "Decision model unavailable."}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {wide && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={toggleBottom} aria-expanded={!bottomCollapsed}>
              {bottomCollapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
              {bottomCollapsed ? "Show judges and trace" : "Hide judges and trace"}
            </Button>
          )}
        </div>
      </div>}

      {wide ? (
        <ResizablePanelGroup orientation="vertical" id="console-outer" {...outer} className="min-h-0 flex-1">
          <ResizablePanel id="console-main-row" defaultSize="68%" minSize="30%">
            <ResizablePanelGroup orientation="horizontal" id="console-main" {...main}>
              <ResizablePanel id="console-left" defaultSize="26%" minSize="14%" className="flex min-w-0 flex-col">{media}</ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="console-conversation" defaultSize="42%" minSize="24%" className="flex min-w-0 flex-col">{conversation}</ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="console-right" defaultSize="32%" minSize="14%" className="flex min-w-0 flex-col">
                <ResizablePanelGroup orientation="vertical" id="console-right-column" {...right}>
                  <ResizablePanel id="console-metrics" defaultSize="50%" minSize="20%" className="flex min-h-0 flex-col">{metrics}</ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="console-objectives" defaultSize="50%" minSize="20%" className="flex min-h-0 flex-col">{objectives}</ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="console-bottom" defaultSize="32%" minSize="12%" collapsible collapsedSize="0%"
            panelRef={bottomRef} onResize={() => setBottomCollapsed(bottomRef.current?.isCollapsed() ?? false)}
            className="flex min-w-0 flex-col"
          >
            {judges}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <Tabs defaultValue="call" className="min-h-0 flex-1 gap-0">
          {([["call", media], ["conversation", conversation], ["metrics", metrics], ["objectives", objectives], ["judges", judges]] as const).map(([value, content]) => (
            <TabsContent
              key={value}
              value={value}
              forceMount
              className={cn("min-h-0 flex-1 flex-col overflow-hidden", "data-[state=inactive]:hidden", "data-[state=active]:flex")}
            >
              {content}
            </TabsContent>
          ))}
          <TabsList className="h-11 w-full shrink-0 rounded-none border-t">
            {NARROW_TABS.map((t) => <TabsTrigger key={t.value} value={t.value} className="px-1 text-xs">{t.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      )}
    </div>
  );
}
