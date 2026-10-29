/**
 * The tool-call card, copied in from Vercel's AI Elements Tool component
 * (https://ai-sdk.dev/elements, components/ai-elements/tool.tsx) and adapted:
 * the Radix collapsible is the native details element, the badges and code
 * blocks use the console design tokens, and the parts read a live tool call.
 */
import type { ReactNode } from "react";
import "./tool.css";
import { useToolCall, type ToolCall, type ToolStatus } from "./toolEvents";

const STATUS_LABEL: Record<ToolStatus, string> = { running: "Running", done: "Done", failed: "Failed" };

export function ToolHeader({ name, status }: { name: string; status: ToolStatus }) {
  return (
    <summary className="tool-header">
      <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span className="tool-name">{name}</span>
      <span className={`tool-badge tool-badge-${status}`} role="status">
        <span className="tool-badge-dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      <svg className="tool-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
    </summary>
  );
}

const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

export function ToolInput({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="tool-section">
      <h4 className="tool-section-title">Parameters</h4>
      <pre className="tool-code">{pretty(input)}</pre>
    </div>
  );
}

export function ToolOutput({ output, failed }: { output: unknown; failed: boolean }) {
  if (output === undefined) return null;
  return (
    <div className="tool-section">
      <h4 className="tool-section-title">{failed ? "Error" : "Result"}</h4>
      <pre className={failed ? "tool-code tool-code-error" : "tool-code"}>{pretty(output)}</pre>
    </div>
  );
}

export function Tool({ call, children }: { call: ToolCall; children?: ReactNode }) {
  return (
    <details className="tool" data-status={call.status}>
      <ToolHeader name={call.name} status={call.status} />
      <div className="tool-content">
        <ToolInput input={call.args} />
        <ToolOutput output={call.result} failed={call.status === "failed"} />
        {children}
      </div>
    </details>
  );
}

/** A card placed in the conversation by id; it follows the call as its result arrives. */
export function LiveToolCard({ id }: { id: string }) {
  const call = useToolCall(id);
  return call ? <Tool call={call} /> : null;
}
