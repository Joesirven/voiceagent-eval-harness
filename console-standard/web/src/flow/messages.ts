/**
 * The message handshake with the framed pipecat flows editor, as small pure functions.
 * The editor runs as its own program on one fixed origin; the panel frames it and talks to
 * it by messages. Nothing here touches the window, so every rule can be tested alone.
 */

/** The one place the editor origin is written. */
export const EDITOR_ORIGIN = "http://127.0.0.1:4335";
export const HANDSHAKE_TIMEOUT_MS = 5000;

/** The address of the framed editor, told which origin its parent page has. */
export function editorFrameUrl(parentOrigin: string): string {
  return `${EDITOR_ORIGIN}/editor?parent=${encodeURIComponent(parentOrigin)}`;
}

export type EditorMessage =
  | { type: "ready"; hasDraft: boolean }
  | { type: "saved"; flowName: string; yaml: string }
  | { type: "changed"; yaml: string };

export interface IncomingMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * Accepts a message only when it comes from the editor origin AND from the frame's own window.
 * Returns the message in a typed form, or null for anything else (wrong origin, wrong window,
 * not an object, unknown type, or a required field of the wrong kind).
 */
export function readEditorMessage(event: IncomingMessage, frameWindow: unknown): EditorMessage | null {
  if (event.origin !== EDITOR_ORIGIN) return null;
  if (!frameWindow || event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type === "crm-editor-ready") {
    // Fails safe: only an explicit false means there is no draft to protect.
    return { type: "ready", hasDraft: message.hasDraft !== false };
  }
  if (message.type === "crm-flow-saved") {
    if (typeof message.yaml !== "string") return null;
    return { type: "saved", flowName: typeof message.flowName === "string" ? message.flowName : "flow", yaml: message.yaml };
  }
  if (message.type === "crm-flow-changed") {
    if (typeof message.yaml !== "string") return null;
    return { type: "changed", yaml: message.yaml };
  }
  return null;
}

export interface LoadPayload {
  catalog: unknown;
  flowName?: string;
  yaml?: string;
}

/**
 * The load message for the editor. The runtime flow is included only when the editor said it
 * has no draft (hasDraft false) or when the person confirmed replacing the draft.
 */
export function buildLoadMessage(catalog: unknown, flow: { flowName: string; yaml: string } | null, options: { hasDraft: boolean; confirmed: boolean }): Record<string, unknown> {
  const mayReplaceDraft = options.confirmed || options.hasDraft === false;
  if (flow && mayReplaceDraft) return { type: "crm-load", catalog, flowName: flow.flowName, yaml: flow.yaml };
  return { type: "crm-load", catalog };
}

/** Posts to the editor frame, always to the exact editor origin and never to any origin. */
export function postToEditor(frameWindow: Pick<Window, "postMessage"> | null | undefined, message: Record<string, unknown>): void {
  frameWindow?.postMessage(message, EDITOR_ORIGIN);
}
