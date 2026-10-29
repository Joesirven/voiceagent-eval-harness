/**
 * Flow tool calls as the bot reports them: a start event, then a result event
 * with the same id. The store keeps each call so its card can go from running
 * to done or failed after it has been placed in the conversation.
 */
import { useSyncExternalStore } from "react";

export type ToolStatus = "running" | "done" | "failed";
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: unknown;
  source?: string;
}

const calls = new Map<string, ToolCall>();
const listeners = new Set<() => void>();
let unnamed = 0;
const emit = () => listeners.forEach((l) => l());

/** Applies one server message. Returns the id of a call seen for the first time, so the caller can place its card. */
export function applyFlowEvent(data: any): string | undefined {
  if (data?.type !== "flow") return undefined;
  if (data.event === "tool") {
    const id = typeof data.id === "string" && data.id ? data.id : `call-${++unnamed}`;
    const known = calls.get(id);
    calls.set(id, {
      id,
      name: String(data.name ?? "tool"),
      args: data.args && typeof data.args === "object" ? data.args : {},
      status: known?.status ?? "running",
      result: known?.result,
      source: typeof data.source === "string" ? data.source : undefined,
    });
    emit();
    return known ? undefined : id;
  }
  if (data.event === "tool_result" && typeof data.id === "string") {
    const known = calls.get(data.id);
    const status: ToolStatus = data.ok === false ? "failed" : "done";
    calls.set(data.id, { id: data.id, name: String(data.name ?? known?.name ?? "tool"), args: known?.args ?? {}, source: known?.source, status, result: data.result });
    emit();
    return known ? undefined : data.id;
  }
  return undefined;
}

export function useToolCall(id: string): ToolCall | undefined {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => calls.get(id),
  );
}

/** For tests. */
export function resetToolCalls() { calls.clear(); unnamed = 0; emit(); }
