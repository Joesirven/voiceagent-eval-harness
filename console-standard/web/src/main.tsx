import "@pipecat-ai/voice-ui-kit/styles.css";
import "./app.css";
import "./brand.css";
import { ConsolePresentation as ConsoleTemplate } from "./console/ConsolePresentation";
import { RTVIEvent, type PipecatClient } from "@pipecat-ai/client-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigPanel } from "./config/ConfigPanel";
import { SETTING_KEYS, type Config, type Options } from "./config/options";
import { LiveToolCard } from "./conversation/Tool";
import { applyFlowEvent } from "./conversation/toolEvents";

const ConsoleName = () => <span className="text-lg font-semibold tracking-tight text-foreground">Voice Agent Console</span>;

const IDLE_STATES = new Set(["disconnected", "initialized", "error"]);

/** Whether a call is in progress or starting. Read from the template's client through its onClient callback (no slot exists yet). */
function useCallActive() {
  const [active, setActive] = useState(false);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => unsubscribe.current?.(), []);
  const onClient = useCallback((client: PipecatClient) => {
    unsubscribe.current?.();
    const update = (state: string) => setActive(!IDLE_STATES.has(state));
    client.on(RTVIEvent.TransportStateChanged, update);
    update(client.state);
    unsubscribe.current = () => client.off(RTVIEvent.TransportStateChanged, update);
  }, []);
  return { active, onClient };
}

// Defined once at module level: a new function on each render would make the kit rebuild its client.
const startBotResponseTransformer = (r: any) => ({ webrtcUrl: `/sessions/${r.sessionId}/api/offer` });

const settingsOf = (c: Config) => Object.fromEntries(SETTING_KEYS.map((k) => [k, c[k]]));

function App() {
  const [configs, setConfigs] = useState<Config[]>([]);
  const [options, setOptions] = useState<Options>();
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem("console-config") ?? "quote-prototype");
  const [edits, setEdits] = useState<Partial<Config>>({});
  const { active, onClient } = useCallActive();
  // The latest save_quote_field tool event from the flow, shown in the lead state card.
  const [savedField, setSavedField] = useState<{ field: string; value: unknown; seq: number }>();
  // Each flow tool call is placed once in the conversation, between the transcript lines, as a live card.
  const injectRef = useRef<((message: { role: "user" | "assistant" | "system"; parts: any[] }) => void) | undefined>(undefined);
  const onInjectMessage = useCallback((inject: typeof injectRef.current) => { injectRef.current = inject; }, []);
  const onServerMessage = useCallback((data: any) => {
    const placed = applyFlowEvent(data);
    if (placed && injectRef.current) {
      injectRef.current({ role: "system", parts: [{ text: <LiveToolCard id={placed} />, final: true, createdAt: new Date().toISOString() }] });
    }
    if (data?.type === "flow" && data.event === "tool" && data.name === "save_quote_field" && typeof data.args?.field === "string") {
      setSavedField((prev) => ({ field: data.args.field, value: data.args.value, seq: (prev?.seq ?? 0) + 1 }));
    }
  }, []);
  useEffect(() => { fetch("/configs").then((r) => r.json()).then((j) => setConfigs(j.configs)).catch(() => {}); }, []);
  useEffect(() => { fetch("/options").then((r) => r.json()).then(setOptions).catch(() => {}); }, []);
  const selected = configs.find((c) => c.id === selectedId) ?? configs.find((c) => c.id === "quote-prototype") ?? configs[0];
  const working = useMemo(() => (selected ? { ...selected, ...edits } : undefined), [selected, edits]);
  // The kit rebuilds its client (a disconnect and a reconnect) whenever the startBotParams object changes identity.
  // So one object is created once and its settings are overwritten in place; the kit reads them when Connect is pressed.
  const startBotParams = useRef({ endpoint: "/start", requestData: { transport: "webrtc", body: { config: {} as Record<string, string | number> } } }).current;
  if (working) startBotParams.requestData.body.config = settingsOf(working);

  if (!selected || !working) return null;
  const choose = (id: string) => { localStorage.setItem("console-config", id); setSelectedId(id); setEdits({}); };
  return (
    <ConsoleTemplate
      transportType="smallwebrtc"
      startBotParams={startBotParams}
      startBotResponseTransformer={startBotResponseTransformer}
      onClient={onClient}
      onServerMessage={onServerMessage}
      onInjectMessage={onInjectMessage}
      titleText="Voice Agent Console"
      logoComponent={<ConsoleName />}
      noUserVideo
      noScreenControl
      noBotVideo
      configuration={{
        configs,
        selectedId: selected.id,
        onSelect: choose,
        onSaved: (c) => { setConfigs((list) => [...list.filter((x) => x.id !== c.id), c]); choose(c.id); },
        options,
        disabled: active,
        working,
        onChange: (patch) => setEdits((e) => ({ ...e, ...patch })),
        savedField,
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
