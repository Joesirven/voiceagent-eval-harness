import { describe, expect, it, vi } from "vitest";
import { buildLoadMessage, editorFrameUrl, EDITOR_ORIGIN, postToEditor, readEditorMessage } from "./messages";

const frame = {};
const from = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: EDITOR_ORIGIN, source: frame, data, ...over });

describe("readEditorMessage", () => {
  it("accepts the editor origin from the frame window", () => {
    expect(readEditorMessage(from({ type: "crm-editor-ready", hasDraft: false }), frame)).toEqual({ type: "ready", hasDraft: false });
  });
  it("rejects another origin, another window, a missing frame and non-object data", () => {
    const ready = { type: "crm-editor-ready", hasDraft: false };
    expect(readEditorMessage(from(ready, { origin: "http://evil.example" }), frame)).toBeNull();
    expect(readEditorMessage(from(ready, { origin: "http://127.0.0.1:4336" }), frame)).toBeNull();
    expect(readEditorMessage(from(ready, { source: {} }), frame)).toBeNull();
    expect(readEditorMessage(from(ready), null)).toBeNull();
    expect(readEditorMessage(from(ready), undefined)).toBeNull();
    expect(readEditorMessage(from("text"), frame)).toBeNull();
    expect(readEditorMessage(from(null), frame)).toBeNull();
    expect(readEditorMessage(from({ type: "other" }), frame)).toBeNull();
  });
  it("treats anything but an explicit false as having a draft", () => {
    for (const extra of [{}, { hasDraft: null }, { hasDraft: "false" }, { hasDraft: 0 }, { hasDraft: true }]) {
      expect(readEditorMessage(from({ type: "crm-editor-ready", ...extra }), frame)).toEqual({ type: "ready", hasDraft: true });
    }
  });
  it("reads saved and changed messages only with a text yaml", () => {
    expect(readEditorMessage(from({ type: "crm-flow-saved", flowName: "demo", yaml: "a: b" }), frame)).toEqual({ type: "saved", flowName: "demo", yaml: "a: b" });
    expect(readEditorMessage(from({ type: "crm-flow-saved", yaml: "a: b" }), frame)).toEqual({ type: "saved", flowName: "flow", yaml: "a: b" });
    expect(readEditorMessage(from({ type: "crm-flow-saved", flowName: "demo", yaml: 5 }), frame)).toBeNull();
    expect(readEditorMessage(from({ type: "crm-flow-changed", yaml: "x: 1" }), frame)).toEqual({ type: "changed", yaml: "x: 1" });
    expect(readEditorMessage(from({ type: "crm-flow-changed" }), frame)).toBeNull();
  });
});

describe("buildLoadMessage and postToEditor", () => {
  const flow = { flowName: "runtime", yaml: "nodes: {}\n" };
  it("includes the flow only when hasDraft is false or confirmed", () => {
    expect(buildLoadMessage({ tools: [] }, flow, { hasDraft: false, confirmed: false })).toEqual({ type: "crm-load", catalog: { tools: [] }, ...flow });
    expect(buildLoadMessage({ tools: [] }, flow, { hasDraft: true, confirmed: true })).toMatchObject(flow);
    const withheld = buildLoadMessage({ tools: [] }, flow, { hasDraft: true, confirmed: false });
    expect("yaml" in withheld).toBe(false);
    expect("flowName" in withheld).toBe(false);
  });
  it("sends only the catalog when there is no flow", () => {
    expect(buildLoadMessage({ tools: [] }, null, { hasDraft: false, confirmed: false })).toEqual({ type: "crm-load", catalog: { tools: [] } });
  });
  it("posts to the exact editor origin, never *", () => {
    const postMessage = vi.fn();
    postToEditor({ postMessage } as unknown as Window, { type: "crm-load" });
    expect(postMessage).toHaveBeenCalledWith({ type: "crm-load" }, EDITOR_ORIGIN);
    expect(postMessage.mock.calls.every((c) => c[1] !== "*")).toBe(true);
    expect(() => postToEditor(null, {})).not.toThrow();
  });
  it("builds the frame address with the encoded parent origin", () => {
    expect(editorFrameUrl("http://127.0.0.1:4351")).toBe("http://127.0.0.1:4335/editor?parent=http%3A%2F%2F127.0.0.1%3A4351");
  });
});
