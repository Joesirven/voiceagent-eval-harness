import {
  BotAudioPanel, BotVideoPanel, Button, ClientStatus, ConnectButton,
  ConversationPanel, DTMFKeypad, EventsPanel, PipecatAppBase,
  Popover, PopoverContent, PopoverTrigger, ResizableHandle, ResizablePanel,
  ResizablePanelGroup, SessionInfo, SpinLoader, Tabs, TabsContent, TabsList,
  TabsTrigger, ThemeModeToggle, UserAudioControl, UserScreenControl,
  UserVideoControl, type ConsoleTemplate, type PipecatBaseChildProps,
  type PipecatBaseProps,
} from "@pipecat-ai/voice-ui-kit";
import { RTVIEvent } from "@pipecat-ai/client-js";
import {
  usePipecatClient, usePipecatClientCamControl, usePipecatConversation,
  useRTVIClientEvent,
} from "@pipecat-ai/client-react";
import { useEffect, useRef, useState, type ComponentProps, type ComponentRef } from "react";
import { ConfigPanel, type ConfigPanelProps } from "../config/ConfigPanel";
import { FlowPanel } from "../flow/FlowPanel";
import { DecisionMap } from "../decision/DecisionMap";
import { applyDecisionEvent, emptyDecisionState } from "../decision/state";
import { PromptPanel } from "../prompt/PromptPanel";

export type ConsolePresentationProps = ComponentProps<typeof ConsoleTemplate> & {
  configuration: ConfigPanelProps;
};

const defaultClientOptions = { enableCam: false, enableMic: true };
const defaultTransportOptions = {};

/** Keep connection initialization and audio output owned by the kit. */
export function ConsolePresentation(props: ConsolePresentationProps) {
  return (
    <PipecatAppBase
      connectParams={props.connectParams}
      connectOnMount={props.connectOnMount}
      initDevicesOnMount={!props.noAutoInitDevices}
      onClient={props.onClient}
      startBotParams={props.startBotParams}
      startBotResponseTransformer={props.startBotResponseTransformer}
      transportType={props.transportType ?? "smallwebrtc"}
      clientOptions={props.clientOptions ?? defaultClientOptions}
      transportOptions={props.transportOptions ?? defaultTransportOptions}
      themeProps={{ defaultTheme: props.theme, ...props.themeProps }}
      noThemeProvider={props.noThemeProvider}
      noAudioOutput={props.noAudioOutput}
    >
      {(connection) => connection.client ? (
        <ConsoleWorkspace {...props} {...connection} />
      ) : (
        <div className="console-loading" role="status" aria-label="Initializing voice console">
          <SpinLoader />
        </div>
      )}
    </PipecatAppBase>
  );
}

function useCompactLayout() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 63.999rem)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 63.999rem)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function CodecSettings({ audioCodec = "default", videoCodec = "default", transportType }: {
  audioCodec?: string;
  videoCodec?: string;
  transportType: PipecatBaseProps["transportType"];
}) {
  const client = usePipecatClient();
  useEffect(() => {
    if (!client || transportType !== "smallwebrtc") return;
    let cancelled = false;
    import("@pipecat-ai/small-webrtc-transport").then(({ SmallWebRTCTransport }) => {
      if (cancelled || !(client.transport instanceof SmallWebRTCTransport)) return;
      if (audioCodec) client.transport.setAudioCodec(audioCodec);
      if (videoCodec) client.transport.setVideoCodec(videoCodec);
    });
    return () => { cancelled = true; };
  }, [audioCodec, client, transportType, videoCodec]);
  return null;
}

function ConsoleWorkspace(props: ConsolePresentationProps & PipecatBaseChildProps) {
  const compact = useCompactLayout();
  const [decisionState, setDecisionState] = useState(emptyDecisionState);
  useRTVIClientEvent(RTVIEvent.TransportStateChanged, (state) => {
    if (state === "connecting") setDecisionState(emptyDecisionState);
  });
  const mediaRef = useRef<ComponentRef<typeof ResizablePanel>>(null);
  const infoRef = useRef<ComponentRef<typeof ResizablePanel>>(null);
  const eventsRef = useRef<ComponentRef<typeof ResizablePanel>>(null);
  const [mediaCollapsed, setMediaCollapsed] = useState(!!props.collapseMediaPanel);
  const [infoCollapsed, setInfoCollapsed] = useState(!!props.collapseInfoPanel);
  const [eventsCollapsed, setEventsCollapsed] = useState(false);
  const [participantId, setParticipantId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [activeTab, setActiveTab] = useState(
    props.noConversation ? (props.noMetrics ? "flow" : "metrics") : "conversation",
  );
  const { injectMessage } = usePipecatConversation();
  const { isCamEnabled } = usePipecatClientCamControl();

  useEffect(() => { props.onInjectMessage?.(injectMessage); }, [props.onInjectMessage, injectMessage]);
  useRTVIClientEvent(RTVIEvent.ParticipantConnected, (participant) => {
    if (participant.local) setParticipantId(participant.id || "");
  });
  useRTVIClientEvent(RTVIEvent.TrackStarted, (_track, participant) => {
    if (participant?.local && participant.id) setParticipantId(participant.id);
  });
  useRTVIClientEvent(RTVIEvent.BotStarted, (data) => {
    const session = data as { sessionId?: string };
    if (session?.sessionId) setSessionId(session.sessionId);
  });
  useRTVIClientEvent(RTVIEvent.ServerMessage, (data) => {
    setDecisionState((state) => applyDecisionEvent(state, data));
    props.onServerMessage?.(data);
  });

  const hasMedia = !props.noBotAudio || !props.noBotVideo;
  const hasDevices = !props.noUserAudio || !props.noUserVideo || !props.noScreenControl;
  // Initial proportions match the reference widths; native handles own later resizing.
  const [sizes] = useState(() => ({
    media: Math.min(33, 336 / window.innerWidth * 100),
    info: Math.min(29, 264 / window.innerWidth * 100),
    mediaMin: Math.min(12, 176 / window.innerWidth * 100),
    infoMin: Math.min(18, 220 / window.innerWidth * 100),
  }));
  const conversationProps = {
    noTextInput: props.noTextInput,
    textRenderMode: props.textRenderMode,
    noTextRenderModeSwitch: props.noTextRenderModeSwitch,
    conversationElementProps: {
      ...props.conversationElementProps,
      assistantLabel: props.assistantLabelText,
      clientLabel: props.userLabelText,
      systemLabel: props.systemLabelText,
    },
  };

  return (
    <div className="console-console">
      <CodecSettings audioCodec={props.audioCodec} videoCodec={props.videoCodec} transportType={props.transportType ?? "smallwebrtc"} />
      <div className="console-brand-bar">
        {!props.noLogo && (props.logoComponent ?? <span className="console-wordmark">Voice Agent Console</span>)}
      </div>
      <header className="console-page-heading">
        <div>
          <h1>{props.titleText ?? props.title ?? "Voice Agent Console"}</h1>
          <p>Talk to the agent. Follow the conversation and events.</p>
        </div>
        <div className="console-actions">
          {!props.noDTMF && (
            <Popover>
              <PopoverTrigger asChild><Button variant="ghost">Keypad</Button></PopoverTrigger>
              <PopoverContent align="end" className="console-keypad">
                <DTMFKeypad mode={props.keypadMode ?? "buffered"} />
              </PopoverContent>
            </Popover>
          )}
          {!props.noThemeSwitch && <ThemeModeToggle />}
          <div className="console-panel-actions">
            {hasMedia && (
              <Button variant="ghost" aria-controls="console-audio" aria-expanded={!mediaCollapsed}
                onClick={() => mediaCollapsed ? mediaRef.current?.expand() : mediaRef.current?.collapse()}>
                {mediaCollapsed ? "Show audio" : "Hide audio"}
              </Button>
            )}
            <Button variant="ghost" aria-controls="console-information" aria-expanded={!infoCollapsed}
              onClick={() => infoCollapsed ? infoRef.current?.expand() : infoRef.current?.collapse()}>
              {infoCollapsed ? "Show settings" : "Hide settings"}
            </Button>
            <Button variant="ghost" aria-controls="console-events" aria-expanded={!eventsCollapsed}
              onClick={() => eventsCollapsed ? eventsRef.current?.expand() : eventsRef.current?.collapse()}>
              {eventsCollapsed ? "Show decision map" : "Hide decision map"}
            </Button>
          </div>
          <ConnectButton onConnect={props.handleConnect} onDisconnect={props.handleDisconnect} />
        </div>
      </header>
      {props.error && <div className="console-connection-error" role="alert">{props.error}</div>}
      <ResizablePanelGroup direction="vertical" className="console-workspace">
        <ResizablePanel defaultSize={75} minSize={40} className="console-main-panel">
          <ResizablePanelGroup direction="horizontal" className="console-columns">
            {hasMedia && (
              <>
                <ResizablePanel ref={mediaRef} id="console-audio" className="console-audio-pane"
                  defaultSize={props.collapseMediaPanel ? 4 : sizes.media} minSize={sizes.mediaMin} maxSize={40}
                  collapsible collapsedSize={4} onCollapse={() => setMediaCollapsed(true)} onExpand={() => setMediaCollapsed(false)}>
                  {!props.noBotAudio && <BotAudioPanel collapsed={!compact && mediaCollapsed} noControls={props.noBotAudioControls || props.noAudioOutput} />}
                  {!props.noBotVideo && <BotVideoPanel collapsed={!compact && mediaCollapsed} />}
                </ResizablePanel>
                <ResizableHandle withHandle aria-label="Resize audio pane" />
              </>
            )}
            <ResizablePanel className="console-center-pane" minSize={25}
              defaultSize={100 - (hasMedia ? (props.collapseMediaPanel ? 4 : sizes.media) : 0) - (props.collapseInfoPanel ? 4 : sizes.info)}>
              <Tabs value={activeTab} onValueChange={setActiveTab} className="console-center-tabs">
                <TabsList aria-label="Console workspace" className="console-workspace-tabs">
                  {!props.noConversation && <TabsTrigger value="conversation">Conversation</TabsTrigger>}
                  {!props.noMetrics && <TabsTrigger value="metrics">Metrics</TabsTrigger>}
                  <TabsTrigger value="flow">Flow Configuration</TabsTrigger>
                </TabsList>
                <TabsContent value="conversation" className="console-conversation-slot">
                  {activeTab === "conversation" && <ConversationPanel key="conversation" {...conversationProps} noMetrics />}
                </TabsContent>
                <TabsContent value="metrics" className="console-metrics-slot">
                  {activeTab === "metrics" && <ConversationPanel key="metrics" noConversation noTextRenderModeSwitch />}
                </TabsContent>
                <TabsContent value="flow" className="console-flow-slot">
                  <section className="console-editor-section" aria-labelledby="console-flow-title">
                    <h2 id="console-flow-title">Flow</h2>
                    <div className="console-editor-slot"><FlowPanel /></div>
                  </section>
                  <section className="console-editor-section" aria-labelledby="console-prompts-title">
                    <h2 id="console-prompts-title">Prompts</h2>
                    <div className="console-editor-slot"><PromptPanel /></div>
                  </section>
                </TabsContent>
              </Tabs>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize settings pane" />
            <ResizablePanel ref={infoRef} id="console-information" className="console-info-pane"
              defaultSize={props.collapseInfoPanel ? 4 : sizes.info} minSize={sizes.infoMin}
              collapsible collapsedSize={4} onCollapse={() => setInfoCollapsed(true)} onExpand={() => setInfoCollapsed(false)}>
              <aside aria-label="Session settings" className="console-info-content" tabIndex={0} hidden={!compact && infoCollapsed}>
                {!props.noStatusInfo && <section className="console-info-section"><h2>Status</h2><ClientStatus /></section>}
                <section className="console-info-section"><h2>Configuration</h2><ConfigPanel {...props.configuration} /></section>
                {hasDevices && (
                  <section className="console-info-section"><h2>Devices</h2>
                    {!props.noUserAudio && (
                      <UserAudioControl
                        buttonProps={{ "aria-label": "Toggle microphone" }}
                        dropdownButtonProps={{ "aria-label": "Choose audio devices" }}
                      />
                    )}
                    {!props.noUserVideo && <UserVideoControl noVideo={!isCamEnabled} />}
                    {!props.noScreenControl && <UserScreenControl />}
                  </section>
                )}
                {!props.noSessionInfo && <section className="console-info-section"><h2>Session</h2><SessionInfo participantId={participantId} sessionId={sessionId} /></section>}
              </aside>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize decision map and events pane" />
        <ResizablePanel ref={eventsRef} id="console-events" className="console-events-pane"
          defaultSize={25} minSize={10} collapsible collapsedSize={5}
          onCollapse={() => setEventsCollapsed(true)} onExpand={() => setEventsCollapsed(false)}>
          <Tabs defaultValue="decisions" className="decision-tabs">
            <TabsList aria-label="Agent activity" className="console-workspace-tabs">
              <TabsTrigger value="decisions">Agent decision map</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="decisions" hidden={!compact && eventsCollapsed}>
              <DecisionMap key={decisionState.nodes.map((n) => n.id).join("|")} state={decisionState} />
            </TabsContent>
            <TabsContent value="events"><EventsPanel collapsed={!compact && eventsCollapsed} /></TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
