/** STOP requests are recorded at once and prevent later contact. */
import { beforeEach, describe, expect, it } from "vitest";
import { detectStopRequest } from "../../src/compliance/stop.js";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, getStopLedger, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { baseLead } from "../helpers/fixtures.js";

const NOW = "2026-10-15T14:00:00.000Z";

beforeEach(() => {
  resetHarnessConfig();
  setAiCallingEnabled("agency-demo", true);
  resetLeadStore();
  clearCallLogs();
  seedLead(baseLead());
});

describe("detecting a request to stop", () => {
  it.each(["Please stop calling me", "Do not call this number", "STOP", "Unsubscribe", "Remove my number"])(
    "%s is a stop",
    (text) => expect(detectStopRequest(text)).not.toBeNull(),
  );

  it.each(["I wait at the bus stop", "Can you stop by tomorrow?", "Stopwatch", "Call me back later"])(
    "%s is not a stop",
    (text) => expect(detectStopRequest(text)).toBeNull(),
  );
});

describe("mock store", () => {
  it("records an inbound stop and blocks later contact", async () => {
    const harness = new CallHarness({ now: () => new Date(NOW) });
    const result = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "inbound-1",
      callerUtterances: ["Hello", "Please stop calling me"],
    });
    expect(result.status).toBe("ai_handled");
    expect(getLead("lead-1")).toMatchObject({ onStopList: true, consentRevokedAt: NOW });
    expect(getStopLedger()).toMatchObject([{ leadId: "lead-1", source: "voice_call", matched: "please stop" }]);
    expect(getCallLogs().some((entry) => entry.reason === "stop_recorded_mock")).toBe(true);
    expect((await harness.sendText("lead-1", "hello", "text-1")).reason).toBe("stop_list");
  });

  it("records a text STOP once", async () => {
    const harness = new CallHarness({ now: () => new Date(NOW) });
    expect(await harness.receiveText("lead-1", "STOP", "message-1")).toMatchObject({ status: "stop_recorded", recorded: "mock" });
    expect((await harness.receiveText("lead-1", "STOP", "message-1")).status).toBe("duplicate");
    expect(getStopLedger()).toHaveLength(1);
  });
});
