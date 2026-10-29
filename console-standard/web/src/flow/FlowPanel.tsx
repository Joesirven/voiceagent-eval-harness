import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ImportResult, importSavedFlow, loadCatalog, loadCurrentFlow } from "./api";
import { type Catalog, EMPTY_CATALOG, toolRow, warningsFor } from "./catalogView";
import "./flow.css";
import { buildLoadMessage, editorFrameUrl, HANDSHAKE_TIMEOUT_MS, postToEditor, readEditorMessage } from "./messages";
import { usedInFlow } from "./usedTools";

const START_COMMAND = "npx next dev -p 4335";
const TIMEOUT_MESSAGE = `The flow editor did not answer. Start the local editor with: ${START_COMMAND}.`;
const CONFIRM_LOAD = "Loading the runtime flow replaces the draft in the editor. Continue?";

/**
 * The Flow panel of the console: the pipecat flows editor in a frame beside a catalog panel.
 * It fills the width of its parent and manages its own split layout.
 */
export function FlowPanel() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogNote, setCatalogNote] = useState("");
  const [flowNote, setFlowNote] = useState("");
  const [yaml, setYaml] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [loadNote, setLoadNote] = useState("");
  const readyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogRef = useRef<Catalog>(EMPTY_CATALOG);

  const src = useMemo(() => editorFrameUrl(window.location.origin), []);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const fetchCatalog = useCallback(async (): Promise<Catalog> => {
    const { catalog: c, note } = await loadCatalog();
    setCatalogNote(note); catalogRef.current = c; setCatalog(c);
    return c;
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = readEditorMessage(event, frameRef.current?.contentWindow);
      if (!message) return;
      if (message.type === "ready") {
        readyRef.current = true; clearTimer(); setTimedOut(false); setReady(true);
        void (async () => {
          const c = await fetchCatalog();
          const flow = await loadCurrentFlow();
          setFlowNote(flow.kind === "failed" ? `The runtime flow could not be read: ${flow.code}` : "");
          const usable = flow.kind === "ok" ? { flowName: flow.flowName, yaml: flow.yaml } : null;
          postToEditor(frameRef.current?.contentWindow, buildLoadMessage(c, usable, { hasDraft: message.hasDraft, confirmed: false }));
        })();
      } else if (message.type === "saved") {
        void importSavedFlow(message.flowName, message.yaml).then(setResult);
      } else {
        setYaml(message.yaml); // a change in the draft is only shown here, never imported
      }
    };
    window.addEventListener("message", onMessage);
    return () => { window.removeEventListener("message", onMessage); clearTimer(); };
  }, [fetchCatalog]);

  const onFrameLoad = () => {
    if (readyRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => { if (!readyRef.current) setTimedOut(true); }, HANDSHAKE_TIMEOUT_MS);
  };

  const retry = () => {
    clearTimer(); readyRef.current = false; setReady(false); setTimedOut(false); setFrameKey((k) => k + 1);
  };

  const loadRuntimeFlow = async () => {
    if (!window.confirm(CONFIRM_LOAD)) return;
    const flow = await loadCurrentFlow();
    if (flow.kind === "missing") { setLoadNote("There is no runtime flow to load yet."); return; }
    if (flow.kind === "failed") { setLoadNote(`The runtime flow could not be read: ${flow.code}`); return; }
    setLoadNote(flow.modifiedAt ? `Loaded the runtime flow, last changed ${flow.modifiedAt}.` : "");
    postToEditor(frameRef.current?.contentWindow, buildLoadMessage(catalogRef.current, { flowName: flow.flowName, yaml: flow.yaml }, { hasDraft: true, confirmed: true }));
  };

  const used = useMemo(() => usedInFlow(yaml, catalog.tools.map((t) => t.name)), [yaml, catalog]);
  const rows = useMemo(() => catalog.tools.map((t) => toolRow(t, used)), [catalog, used]);
  const warnings = useMemo(() => warningsFor(catalog, used), [catalog, used]);

  return (
    <div className="flow-panel">
      <section className="flow-editor" aria-label="Flow editor">
        {timedOut && (
          <div role="alert" className="flow-alert">
            <span className="flow-alert-text">{TIMEOUT_MESSAGE}</span>
            <button type="button" className="config-field" onClick={retry}>Retry</button>
          </div>
        )}
        <iframe key={frameKey} ref={frameRef} src={src} title="Pipecat flows editor" onLoad={onFrameLoad} className="flow-frame" />
      </section>
      <aside aria-label="Flow tools" className={panelOpen ? "flow-side" : "flow-side flow-side-closed"}>
        <div className="flow-side-head">
          <button type="button" className="config-field" aria-expanded={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? "Collapse the side panel" : "Expand the side panel"}
          </button>
          {panelOpen && <h2 className="flow-heading">Tools in the catalog</h2>}
        </div>
        {panelOpen && (
          <div className="flow-side-body">
            <p className="flow-muted">The voice agent speaks live words. The tree lines are guidance in task messages, not scripted speech.</p>
            <p className="flow-muted">A saved flow becomes the runtime flow, and the next Connect with orchestration set to pipecat_flows uses it; no restart needed.</p>
            <p className="flow-muted" aria-live="polite">{ready ? "The editor is connected." : "Waiting for the editor."}</p>
            {catalogNote && <p className="flow-note" role="status">{catalogNote}</p>}
            {flowNote && <p className="flow-note" role="status">{flowNote}</p>}
            <table className="flow-table">
              <thead>
                <tr><th>Tool</th><th>Area</th><th>Risk</th><th>Judge action</th><th>Credential</th><th>Status</th><th>Used in this flow</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="flow-muted">No tools to show.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className="flow-mono">{r.name}</td>
                    <td>{r.area}</td>
                    <td><span className={`flow-badge flow-badge-${r.riskTone}`}>{r.risk}</span></td>
                    <td>{r.judgeAction}</td>
                    <td>{r.credential}</td>
                    <td title={r.statusNote}>{r.status}</td>
                    <td>{r.usedIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {warnings.length > 0 && (
              <div role="region" aria-label="Warnings" className="flow-box flow-box-warning">
                {warnings.map((w) => (
                  <p key={w.name} className="flow-line"><strong>Warning:</strong> the flow uses {w.name} ({w.status}) in {w.nodes.join(", ")}.</p>
                ))}
              </div>
            )}
            <div role="region" aria-label="Last import" className="flow-box">
              <h3 className="flow-subheading">Last import</h3>
              <div role="status" aria-live="polite" className="flow-line">
                {!result && <p className="flow-muted">Nothing imported yet. Save in the editor to import the flow.</p>}
                {result?.kind === "imported" && (
                  <div>
                    <p>Imported{result.path ? <> to <span className="flow-mono flow-wrap">{result.path}</span></> : null} at {result.at.toLocaleTimeString()}.</p>
                    {result.handlersChecked === false && <p className="flow-muted">The tool handlers were not checked.</p>}
                    {result.warnings.length > 0 && <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                  </div>
                )}
                {result && result.kind !== "imported" && (
                  <div>
                    <p><strong>{result.kind === "refused" ? "Import refused" : "Import failed"}</strong> at {result.at.toLocaleTimeString()}:</p>
                    <ul>{result.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  </div>
                )}
              </div>
            </div>
            <div>
              <button type="button" className="config-field" disabled={!ready} onClick={() => void loadRuntimeFlow()}>Load the runtime flow</button>
              {loadNote && <p className="flow-note" role="status">{loadNote}</p>}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
