import { afterEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig } from "../../src/config.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { liveTestSnapshot, resetLiveTestState, setAzureLiveDeployment, setLiveTestPath, startVapiTestCall } from "../../src/server/live-test.js";
import { isKnownAzureDeployment } from "../../src/server/voice/azure-deployments.js";
import { placeVapiTestCall } from "../../src/server/voice/vapi-test-call.js";

describe("live test path switch", () => {
  afterEach(() => {
    resetLiveTestState();
    resetModuleRegistry();
    resetHarnessConfig();
    vi.unstubAllGlobals();
  });

  it("lists the same live deployments as the Settings model menu, and refuses a chat model", () => {
    expect(isKnownAzureDeployment("gpt-live-1")).toBe(true);
    // Chat models are not live deployments: the list is the Settings model menu, not a copied list.
    expect(isKnownAzureDeployment("gpt-5.6-luna")).toBe(false);
    expect(isKnownAzureDeployment("gpt-4o")).toBe(false);
    expect(liveTestSnapshot({}).azureDeployments.map((d) => d.name)).toEqual(getModuleRegistry().get("azure-gpt-live").info().modelChoices);
    expect(() => setAzureLiveDeployment("gpt-5.6-luna")).toThrow("azure_model_not_deployed");
  });

  it("refuses Vapi call when Azure path is selected", async () => {
    setLiveTestPath("azure");
    await expect(startVapiTestCall("Jane")).rejects.toThrow(/azure_not_vapi/);
  });

  it("places Vapi call only to the allowlisted test number", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "call-abc", status: "queued" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = { VOICE_HARNESS_DEV_ENV_FILE: "/tmp/fake.env" };
    const fs = {
      mode: () => 0o600,
      read: () =>
        [
          "VAPI_API_KEY=key",
          "VAPI_PILOT_PHONE_NUMBER_ID=pn",
          "VAPI_PILOT_ASSISTANT_ID=asst",
          "VOICE_HARNESS_TEST_PHONE=+15550167",
        ].join("\n"),
    };
    await placeVapiTestCall({
      customerPhone: "+15550167",
      variableValues: {
        first_name: "Jane",
        business_name: "Biz",
        producer_name: "Prod",
        agency_name: "Agency",
        current_carrier: "Carrier",
        renewal_month: "Jan",
      },
      env,
      fs,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.customer.number).toBe("+15550167");
    await expect(
      placeVapiTestCall({
        customerPhone: "+15550177",
        variableValues: body.assistantOverrides.variableValues,
        env,
        fs,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/allowlisted/);
  });
});
