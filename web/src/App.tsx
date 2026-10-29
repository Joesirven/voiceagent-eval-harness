import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorsPanel, useVoiceErrorToasts } from "@/components/ErrorsPanel";
import { CallSetupDialog } from "@/components/CallSetupDialog";
import { CallView } from "@/components/CallView";
import { SettingsSheet } from "@/components/SettingsSheet";
import { SimulatorView } from "@/components/SimulatorView";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { act, api } from "@/lib/api";
import { connectEvents, connection, useLiveVersion } from "@/lib/live";
import type { AppState } from "@/lib/types";

// The console brings the conversation kit, the charts and the audio visualizers, so it loads only when its tab is first opened.
const VoiceAgentConsole = lazy(() => import("@/components/console/VoiceAgentConsole").then((m) => ({ default: m.VoiceAgentConsole })));

// The flow editor tab loads on first open, then stays mounted so the draft in the editor frame survives tab switches.
const FlowEditorView = lazy(() => import("@/components/FlowEditorView").then((m) => ({ default: m.FlowEditorView })));

function Brand() {
  return (
    <h1 className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
      <svg viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#1f7c74" /><g fill="white"><path d="M9 27A15 15 0 0 1 39 27Z" /><rect x="9" y="30" width="30" height="3" /><rect x="9" y="36" width="30" height="3" /></g></svg>
      <span>Voice Agent <span className="text-primary">Console</span></span>
    </h1>
  );
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState("call");
  const [inCall, setInCall] = useState(false);
  const [flowOpened, setFlowOpened] = useState(false);
  useEffect(() => { if (tab === "flow") setFlowOpened(true); }, [tab]);
  useLiveVersion();

  const refresh = useCallback(async (next?: AppState) => { setState(next ?? await api<AppState>("/api/state")); }, []);
  useEffect(() => {
    void act(() => refresh());
    const again = () => void refresh().catch(() => {});
    window.addEventListener("harness-refresh", again);
    const timer = setInterval(again, 4000);
    const stop = connectEvents();
    return () => { stop(); clearInterval(timer); window.removeEventListener("harness-refresh", again); };
  }, [refresh]);
  useVoiceErrorToasts(state?.voiceErrors);

  const azureMessage = state?.azureStatus && !state.azureStatus.ok ? state.azureStatus.message ?? "Azure unavailable." : null;
  const moduleMessage = state?.decisionModuleStatus && !state.decisionModuleStatus.available ? state.decisionModuleStatus.message || "Decision model unavailable." : null;
  useEffect(() => { if (azureMessage) toast.error(azureMessage, { id: "azure-status" }); }, [azureMessage]);
  useEffect(() => { if (moduleMessage) toast.warning(moduleMessage, { id: "module-status" }); }, [moduleMessage]);

  return (
    <TooltipProvider><div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-card px-3 py-1.5">
        <Brand />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-8">
            <TabsTrigger value="call" disabled={inCall && tab !== "call"}>Call</TabsTrigger>
            <TabsTrigger value="console" disabled={inCall && tab !== "console"}>Console</TabsTrigger>
            <TabsTrigger value="simulator" disabled={inCall && tab !== "simulator"}>Simulator</TabsTrigger>
            <TabsTrigger value="flow" disabled={inCall && tab !== "flow"}>Flow</TabsTrigger>
          </TabsList>
        </Tabs>
        <nav className="flex gap-3 text-xs text-primary">
          <a href="/mock" className="hover:underline">Scripted demo</a>
          <a href="/simulator" className="hover:underline">Scenarios</a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge variant={connection.state === "Live" ? "secondary" : "outline"} aria-live="polite" className="text-[11px]">{connection.state}</Badge>
          {state && <ErrorsPanel errors={state.voiceErrors ?? []} />}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!state ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <>
            {/* The call controls find their elements by identifier, so only one of the Call tab and the Console tab is mounted at a time. Tabs are locked during a call, so a call is never in the one that unmounts. */}
            {tab === "console" && <div className="flex min-h-0 flex-1 flex-col"><Suspense fallback={<p className="p-3 text-sm text-muted-foreground">Loading the console…</p>}><VoiceAgentConsole state={state} refresh={refresh} inCall={inCall} onInCall={setInCall} /></Suspense></div>}
            {tab !== "console" && <div className={tab === "call" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><CallView state={state} inCall={inCall} onInCall={setInCall} settings={<SettingsSheet state={state} refresh={refresh} />} setup={<CallSetupDialog state={state} refresh={refresh} disabled={inCall} />} /></div>}
            <div className={tab === "simulator" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><SimulatorView key={JSON.stringify(state.modules[0]?.config)} state={state} refresh={refresh} /></div>
            {flowOpened && <div className={tab === "flow" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><Suspense fallback={<p className="p-3 text-sm text-muted-foreground">Loading the flow editor…</p>}><FlowEditorView /></Suspense></div>}
          </>
        )}
      </main>
      <Toaster position="top-right" richColors closeButton />
    </div></TooltipProvider>
  );
}
