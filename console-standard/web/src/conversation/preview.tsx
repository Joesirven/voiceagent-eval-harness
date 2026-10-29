/** Preview of tool cards between transcript lines, driven by a fake event stream (open /tool-preview.html on the dev server). */
import "@pipecat-ai/voice-ui-kit/styles.css";
import "../app.css";
import "../brand.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LiveToolCard } from "./Tool";
import { applyFlowEvent } from "./toolEvents";

type Row = { kind: "line"; who: "Agent" | "Caller"; text: string } | { kind: "tool"; id: string };
const script: Array<[number, Row | object]> = [
  [0, { kind: "line", who: "Agent", text: "This is Maria's AI assistant with Sunrise Insurance. Am I speaking with Dan?" }],
  [300, { kind: "line", who: "Caller", text: "Yes, this is Dan. We have twelve full time people." }],
  [600, { type: "flow", event: "tool", id: "c1", name: "save_quote_field", args: { field: "full_time_employees", value: 12 }, source: "simulated" }],
  [1200, { type: "flow", event: "tool_result", id: "c1", name: "save_quote_field", ok: true, result: { saved: "full_time_employees", value: 12 } }],
  [1500, { kind: "line", who: "Agent", text: "Got it. Can I get a producer on the line for you?" }],
  [1800, { type: "flow", event: "tool", id: "c2", name: "check_producer_available", args: {}, source: "simulated" }],
  [2400, { type: "flow", event: "tool_result", id: "c2", name: "check_producer_available", ok: true, result: { available: false } }],
  [2700, { type: "flow", event: "tool", id: "c3", name: "transfer_to_producer", args: {}, source: "simulated" }],
  [3200, { type: "flow", event: "tool_result", id: "c3", name: "transfer_to_producer", ok: false, result: "No producer is available right now." }],
  [3500, { type: "flow", event: "tool", id: "c4", name: "send_quote_link", args: { channel: "text", destination: "+1 555 0100" }, source: "simulated" }],
];

function Preview() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    const timers = script.map(([at, item]) => setTimeout(() => {
      if ("kind" in item) return setRows((r) => [...r, item as Row]);
      const placed = applyFlowEvent(item);
      if (placed) setRows((r) => [...r, { kind: "tool", id: placed }]);
    }, at));
    // ?open expands every card, to show the arguments and results.
    const opener = setInterval(() => {
      if (location.search.includes("open")) document.querySelectorAll("details.tool").forEach((d) => d.setAttribute("open", ""));
    }, 200);
    return () => { timers.forEach(clearTimeout); clearInterval(opener); };
  }, []);
  return (
    <div style={{ padding: 24, maxWidth: 640, display: "grid", gap: 10, fontFamily: "var(--font-sans)" }}>
      {rows.map((row, i) => row.kind === "line"
        ? <p key={i} style={{ margin: 0 }}><strong style={{ color: row.who === "Agent" ? "var(--color-agent)" : "var(--color-client)" }}>{row.who}</strong> {row.text}</p>
        : <LiveToolCard key={row.id} id={row.id} />)}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
