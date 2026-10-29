// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup";
import { EDITOR_ORIGIN, FlowEditorView, functionNamesByNode, usedInFlow } from "./FlowEditorView";

const catalog = {
  version: 1,
  tools: [
    { name: "write_quote_field", area: "Lead and contact", risk: "reversible_write", judgeAction: "save_quote_field", credential: "none", status: "runs_in_harness_memory" },
    { name: "start_quote", area: "Quoting", risk: "hard_to_undo", judgeAction: "start_quote", credential: "seat session", status: "needs_seat_session" },
    { name: "check_appointment_time", area: "Scheduling", risk: "read_only", judgeAction: null, credential: "none", status: "not_yet_built" },
    { name: "book_producer", area: "Scheduling", risk: "hard_to_undo", judgeAction: "book", credential: "none", status: "runs_in_harness_memory" },
  ],
};
const sampleYaml = `name: demo
nodes:
  greeting:
    task_messages:
      - role: system
        content: "Say hello. functions: - name: fake"
    functions:
      - name: write_quote_field
        handler: x
      - name: decide_next
  quoting:
    functions:
      - name: "start_quote"
      - name: write_quote_field
  closing:
    functions: []
`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let routes: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    "/api/flow-tools/catalog": () => json(catalog),
    "/api/flows/current": () => json({ flowName: "runtime", yaml: "nodes: {}\n" }),
  };
  fetchMock = vi.fn(async (url: string) => (routes[url] ? routes[url]() : json({ error: "nope" }, 404)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount() {
  render(<FlowEditorView />);
  const frame = screen.getByTitle("Pipecat flows editor") as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  return { frame, post };
}
function send(data: unknown, opts: { origin?: string; source?: Window | null } = {}, frame?: HTMLIFrameElement) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: opts.origin ?? EDITOR_ORIGIN, source: opts.source === undefined ? frame!.contentWindow : opts.source }));
  });
}
const urls = () => fetchMock.mock.calls.map((c) => c[0]);

describe("flow editor frame", () => {
  it("frames the editor with the encoded parent origin and a title", () => {
    const { frame } = mount();
    expect(frame.getAttribute("src")).toBe(`${EDITOR_ORIGIN}/editor?parent=${encodeURIComponent(window.location.origin)}`);
  });

  it("ignores messages from another origin or another window", async () => {
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: false }, { origin: "http://evil.example" }, frame);
    send({ type: "voice-agent-editor-ready", hasDraft: false }, { source: window }, frame);
    send({ type: "voice-agent-flow-saved", flowName: "x", yaml: "a: b" }, { origin: "http://evil.example" }, frame);
    await act(async () => { await Promise.resolve(); });
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the load message only to the editor origin, never to any origin", async () => {
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toBe(EDITOR_ORIGIN);
    expect((post.mock.calls as unknown[][]).every((c) => c[1] === EDITOR_ORIGIN)).toBe(true);
  });

  it("includes the flow only when there is no draft, or after the confirmed button", async () => {
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const withDraft = post.mock.calls[0][0] as any;
    expect(withDraft.type).toBe("voice-agent-load");
    expect(withDraft.catalog.tools).toHaveLength(4);
    expect("yaml" in withDraft).toBe(false);
    expect("flowName" in withDraft).toBe(false);

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const button = screen.getByRole("button", { name: "Load the runtime flow" });
    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/replaces the draft in the editor/);
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toMatchObject({ type: "voice-agent-load", flowName: "runtime", yaml: "nodes: {}\n" });
    expect(post.mock.calls[1][1]).toBe(EDITOR_ORIGIN);

    post.mockClear();
    send({ type: "voice-agent-editor-ready", hasDraft: false }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({ flowName: "runtime", yaml: "nodes: {}\n" });
  });

  it("treats a ready message with a missing or non-boolean hasDraft as having a draft", async () => {
    for (const extra of [{}, { hasDraft: null }, { hasDraft: "false" }, { hasDraft: 0 }]) {
      const { frame, post } = mount();
      send({ type: "voice-agent-editor-ready", ...extra }, {}, frame);
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const message = post.mock.calls[0][0] as any;
      expect("yaml" in message).toBe(false);
      expect("flowName" in message).toBe(false);
      cleanup();
    }
  });

  it("tolerates a missing catalog and a missing runtime flow", async () => {
    routes = {};
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: false }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const message = post.mock.calls[0][0] as any;
    expect(message.catalog).toEqual({ version: 0, tools: [] });
    expect("yaml" in message).toBe(false);
    expect(await screen.findByText(/catalog not written yet/)).toBeTruthy();
  });

  it("imports a saved flow and shows the runtime file path", async () => {
    routes["/api/flows/import"] = () => json({ ok: true, path: "/runtime/flow.yaml" });
    const { frame } = mount();
    send({ type: "voice-agent-flow-saved", flowName: "demo", yaml: sampleYaml }, {}, frame);
    expect(await screen.findByText("/runtime/flow.yaml")).toBeTruthy();
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/flows/import")!;
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call[1].body)).toEqual({ flowName: "demo", yaml: sampleYaml });
  });

  it("shows the refusal problem lines", async () => {
    routes["/api/flows/import"] = () => json({ ok: false, problems: ["node greeting: unknown function foo", "no initial node"] }, 422);
    const { frame } = mount();
    send({ type: "voice-agent-flow-saved", flowName: "demo", yaml: sampleYaml }, {}, frame);
    expect(await screen.findByText("node greeting: unknown function foo")).toBeTruthy();
    expect(screen.getByText("no initial node")).toBeTruthy();
    expect(screen.getByText(/Import refused/)).toBeTruthy();
  });

  it("computes which nodes use each tool from a sample flow", () => {
    expect(functionNamesByNode(sampleYaml)).toEqual({
      greeting: ["write_quote_field", "decide_next"],
      quoting: ["start_quote", "write_quote_field"],
      closing: [],
    });
    expect(usedInFlow(sampleYaml, ["write_quote_field", "start_quote", "book_producer"])).toEqual({
      write_quote_field: ["greeting", "quoting"],
      start_quote: ["quoting"],
      book_producer: [],
    });
  });

  it("shows the used-in column and a warning for a blocked tool the flow uses", async () => {
    const { frame } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, frame);
    await screen.findByText("book_producer");
    send({ type: "voice-agent-flow-changed", flowName: "demo", yaml: sampleYaml }, {}, frame);
    const warnings = await screen.findByRole("region", { name: "Warnings" });
    expect(warnings.textContent).toMatch(/Warning:.*start_quote.*needs a signed-in seat session.*quoting/);
    expect(warnings.textContent).not.toMatch(/check_appointment_time/);
    expect(screen.getAllByText("greeting, quoting").length).toBe(1);
    expect(screen.getByText(/The voice agent speaks live words/)).toBeTruthy();
  });

  it("never imports on a flow-changed message", async () => {
    const { frame } = mount();
    send({ type: "voice-agent-flow-changed", flowName: "demo", yaml: sampleYaml }, {}, frame);
    await act(async () => { await Promise.resolve(); });
    expect(urls()).not.toContain("/api/flows/import");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the timeout message after five seconds, and a ready message cancels it", async () => {
    vi.useFakeTimers();
    const { frame } = mount();
    fireEvent.load(frame);
    act(() => { vi.advanceTimersByTime(4900); });
    expect(screen.queryByText(/did not answer/)).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole("alert").textContent).toContain("npx next dev -p 4335");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    cleanup();
    const second = mount();
    fireEvent.load(second.frame);
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, second.frame);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText(/did not answer/)).toBeNull();
  });

  it("Retry reloads the frame", () => {
    vi.useFakeTimers();
    const { frame } = mount();
    fireEvent.load(frame);
    act(() => { vi.advanceTimersByTime(5100); });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(screen.getByTitle("Pipecat flows editor")).not.toBe(frame);
  });

  it("says the catalog could not be read for a server error, differently from the not-written note", async () => {
    routes["/api/flow-tools/catalog"] = () => json({ error: "catalog_invalid" }, 500);
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/The catalog could not be read: catalog_invalid/)).toBeTruthy();
    expect(screen.queryByText(/catalog not written yet/)).toBeNull();
    expect((post.mock.calls[0][0] as any).catalog).toEqual({ version: 0, tools: [] });
  });

  it("says the catalog could not be read after a network failure, and still sends an empty catalog", async () => {
    routes["/api/flow-tools/catalog"] = () => { throw new TypeError("failed to fetch"); };
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: false }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/The catalog could not be read: network error/)).toBeTruthy();
    expect((post.mock.calls[0][0] as any).catalog).toEqual({ version: 0, tools: [] });
  });

  it("tells a failed runtime flow read from a missing one", async () => {
    routes["/api/flows/current"] = () => json({ error: "runtime_flow_unreadable" }, 500);
    const { frame, post } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: false }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect("yaml" in (post.mock.calls[0][0] as any)).toBe(false);
    expect(await screen.findByText(/The runtime flow could not be read: runtime_flow_unreadable/)).toBeTruthy();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Load the runtime flow" }));
    await waitFor(() => expect(screen.getAllByText(/The runtime flow could not be read: runtime_flow_unreadable/).length).toBe(2));

    routes["/api/flows/current"] = () => json({ error: "runtime_flow_not_found" }, 404);
    fireEvent.click(screen.getByRole("button", { name: "Load the runtime flow" }));
    expect(await screen.findByText("There is no runtime flow to load yet.")).toBeTruthy();
  });

  it("does not crash on malformed catalog entries and ignores unknown field names", async () => {
    routes["/api/flow-tools/catalog"] = () => json({
      version: 1,
      tools: [null, 7, "text", [], { area: "no name" }, { name: "odd_tool", area: { a: 1 }, risk: 5, judge_action: "ignored", credential: false, status: 3 }, { name: "good_tool", judgeAction: "book" }],
    });
    const { frame } = mount();
    send({ type: "voice-agent-editor-ready", hasDraft: true }, {}, frame);
    expect(await screen.findByText("odd_tool")).toBeTruthy();
    expect(screen.getByText("good_tool")).toBeTruthy();
    expect(screen.getByText("book")).toBeTruthy();
    expect(screen.queryByText("ignored")).toBeNull();
    expect(screen.queryByText("no name")).toBeNull();
  });

  it("shows warnings and the unchecked handlers note from a successful import, and only trusts ok true", async () => {
    routes["/api/flows/import"] = () => json({ ok: true, path: "/r/f.yaml", warnings: ["warning: slow node"], handlersChecked: false });
    const { frame } = mount();
    send({ type: "voice-agent-flow-saved", flowName: "demo", yaml: sampleYaml }, {}, frame);
    expect(await screen.findByText("warning: slow node")).toBeTruthy();
    expect(screen.getByText(/handlers were not checked/)).toBeTruthy();
    routes["/api/flows/import"] = () => json({ path: "/r/g.yaml" });
    send({ type: "voice-agent-flow-saved", flowName: "demo", yaml: sampleYaml }, {}, frame);
    expect(await screen.findByText(/Import refused/)).toBeTruthy();
    routes["/api/flows/import"] = () => json({ error: "origin_not_allowed" }, 403);
    send({ type: "voice-agent-flow-saved", flowName: "demo", yaml: sampleYaml }, {}, frame);
    expect(await screen.findByText("origin_not_allowed")).toBeTruthy();
  });

  it("removes its message listener on unmount, so a later ready message does nothing", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { frame, post } = mount();
    const win = frame.contentWindow!;
    cleanup();
    expect(remove.mock.calls.some((c) => c[0] === "message")).toBe(true);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "voice-agent-editor-ready", hasDraft: false }, origin: EDITOR_ORIGIN, source: win }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("answers a second ready message after Retry", async () => {
    vi.useFakeTimers();
    const first = mount();
    fireEvent.load(first.frame);
    act(() => { vi.advanceTimersByTime(5100); });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const frame = screen.getByTitle("Pipecat flows editor") as HTMLIFrameElement;
    expect(frame).not.toBe(first.frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    send({ type: "voice-agent-editor-ready", hasDraft: false }, {}, frame);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({ type: "voice-agent-load", flowName: "runtime", yaml: "nodes: {}\n" });
  });
});
