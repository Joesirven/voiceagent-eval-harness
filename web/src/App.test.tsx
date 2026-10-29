// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./test/setup";
import App from "./App";

const state = { modules: [], voiceErrors: [], azureStatus: { ok: true }, decisionModuleStatus: { available: true } };
vi.mock("@/lib/api", () => ({ api: async () => state, act: (fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/live", () => ({ connectEvents: () => () => {}, connection: { state: "Live" }, useLiveVersion: () => 0 }));
vi.mock("@/components/ErrorsPanel", () => ({ ErrorsPanel: () => null, useVoiceErrorToasts: () => {} }));
vi.mock("@/components/SettingsSheet", () => ({ SettingsSheet: () => null }));
// The call setup dialog brings in the microphone client, which needs browser audio; it has its own tests.
vi.mock("@/components/CallSetupDialog", () => ({ CallSetupDialog: () => null }));
vi.mock("@/components/SimulatorView", () => ({ SimulatorView: () => <p>Simulator view</p> }));
vi.mock("@/components/CallView", () => ({
  CallView: ({ onInCall }: any) => <section><p>Call view</p><button onClick={() => onInCall(true)}>Start in the call tab</button></section>,
}));
// The factory runs when the module is first imported, so the count shows when the console chunk is fetched.
const consoleLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/console/VoiceAgentConsole", () => {
  consoleLoads.count += 1;
  return {
  VoiceAgentConsole: ({ onInCall }: any) => <section><p>Console view</p><button onClick={() => onInCall(true)}>Start in the console tab</button></section>,
  };
});

vi.mock("@/components/FlowEditorView", () => ({ FlowEditorView: () => <p>Flow editor view</p> }));

afterEach(cleanup);

describe("app tabs", () => {
  it("fetches the console module only when its tab is first opened", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Call view");
    expect(consoleLoads.count).toBe(0);
    await user.click(screen.getByRole("tab", { name: "Console" }));
    await screen.findByText("Console view");
    expect(consoleLoads.count).toBe(1);
    await user.click(screen.getByRole("tab", { name: "Simulator" }));
    await user.click(screen.getByRole("tab", { name: "Console" }));
    await screen.findByText("Console view");
    expect(consoleLoads.count).toBe(1);
  });

  it("mounts the call controls in only one of the Call tab and the Console tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Call view");
    expect(screen.queryByText("Console view")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Console" }));
    await screen.findByText("Console view");
    expect(screen.queryByText("Call view")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Simulator" }));
    await screen.findByText("Call view");
    expect(screen.queryByText("Console view")).toBeNull();
  });

  it("locks the other tabs while a call runs from the Console tab, and from the Call tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Console" }));
    await user.click(await screen.findByText("Start in the console tab"));
    await waitFor(() => expect((screen.getByRole("tab", { name: "Call" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("tab", { name: "Simulator" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: "Console" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("locks the Console and Simulator tabs while a call runs from the Call tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("Start in the call tab"));
    await waitFor(() => expect((screen.getByRole("tab", { name: "Console" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("tab", { name: "Simulator" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("mounts the Flow view only after the tab is first opened, then keeps it mounted", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Call view");
    expect(screen.queryByText("Flow editor view")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Flow" }));
    const view = await screen.findByText("Flow editor view");
    await user.click(screen.getByRole("tab", { name: "Simulator" }));
    expect(screen.getByText("Flow editor view")).toBe(view);
    expect(view.closest(".hidden")).not.toBeNull();
  });
});
