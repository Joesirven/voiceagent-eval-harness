export interface Branch { label: string; target?: string; }
export interface MapNode { id: string; branches: Branch[]; }
export interface DecisionState { nodes: MapNode[]; current?: string; visited: string[]; }
export const emptyDecisionState: DecisionState = { nodes: [], visited: [] };

/** Only reported node entries count as visits. A possible transition is never a taken path. */
export function applyDecisionEvent(state: DecisionState, value: unknown): DecisionState {
  if (!value || typeof value !== "object") return state;
  const data = value as Record<string, unknown>;
  if (data.type !== "flow") return state;
  if (data.event === "map" && Array.isArray(data.nodes)) {
    const nodes: MapNode[] = [];
    for (const item of data.nodes) {
      if (!item || typeof item.id !== "string" || !Array.isArray(item.branches)) return state;
      const branches: Branch[] = [];
      for (const b of item.branches) {
        if (!b || typeof b.label !== "string" || (b.target !== undefined && typeof b.target !== "string")) return state;
        branches.push({ label: b.label, target: b.target });
      }
      nodes.push({ id: item.id, branches });
    }
    return { nodes, visited: [] };
  }
  if (data.event === "node_enter" && typeof data.node === "string") {
    return { ...state, current: data.node, visited: [...state.visited, data.node].slice(-200) };
  }
  return state;
}
export const readable = (id: string) => id.replace(/[_.]+/g, " ");
