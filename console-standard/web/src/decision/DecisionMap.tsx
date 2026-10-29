import { useState } from "react";
import { readable, type DecisionState } from "./state";
import "./decision.css";

export function DecisionMap({ state }: { state: DecisionState }) {
  const [inspected, setInspected] = useState<string>();
  const id = inspected ?? state.current ?? state.nodes[0]?.id;
  const node = state.nodes.find((n) => n.id === id);
  return <section className="decision-map" aria-label="Agent decision map">
    <header className="decision-toolbar">
      <p role="status">{state.current ? <>Current: <strong>{readable(state.current)}</strong></> : "Waiting for flow events"}</p>
      {state.nodes.length > 0 && <label>Inspect node <select value={id ?? ""} onChange={(e) => setInspected(e.target.value)}>
        {state.nodes.map((n) => <option key={n.id} value={n.id}>{readable(n.id)}</option>)}
      </select></label>}
      <button type="button" disabled={!inspected} onClick={() => setInspected(undefined)}>Follow agent</button>
    </header>
    {!node ? <p className="decision-empty">{state.current ? "The agent reported a node, but its flow map is unavailable." : "Connect with Pipecat Flows to see the loaded flow and the agent’s current step."}</p> : <div className="decision-tree">
      <div className="decision-question" aria-current={node.id === state.current ? "step" : undefined}>
        <span className="decision-eyebrow">{node.id === state.current ? "Agent is here" : state.visited.includes(node.id) ? "Visited node" : "Possible step"}</span>
        <h3>{readable(node.id)}</h3>
        <p>{node.branches.length ? "Available tools and routes" : "No further routes in this flow"}</p>
      </div>
      {node.branches.length > 0 && <ul className="decision-branches">{node.branches.map((branch, i) => <li key={`${branch.label}-${i}`}>
        <div className="decision-branch"><strong>{readable(branch.label)}</strong>
          {branch.target ? <button type="button" disabled={!state.nodes.some((n) => n.id === branch.target)} onClick={() => setInspected(branch.target)} aria-label={`Inspect ${readable(branch.target)}`}>
            <span aria-hidden="true">→ </span>{readable(branch.target)}<span className="decision-inspect">Inspect</span>
          </button> : <span className="decision-stay">Stays at this step</span>}
        </div>
      </li>)}</ul>}
    </div>}
    {state.visited.length > 0 && <nav className="decision-history" aria-label="Observed agent path"><span>Observed path</span>{state.visited.map((visit, i) => <button type="button" key={i} onClick={() => setInspected(visit)} aria-current={i === state.visited.length - 1 ? "step" : undefined}>{readable(visit)}</button>)}</nav>}
  </section>;
}
