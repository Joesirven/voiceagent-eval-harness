import { describe, expect, it, vi } from "vitest";
import { listAzureDeployments } from "../../scripts/list-azure-deployments.js";

const env = { VOICE_HARNESS_DEV_ENV_FILE: "/fake/dev.env" };
const fsWith = (text: string, mode = 0o100600) => ({ mode: () => mode, read: () => text });
const ok = () => vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-live-1", model: "gpt-live" }] }), { status: 200 }));

describe("listing Azure deployments", () => {
  it("never sends the key to a host that is not Azure", async () => {
    for (const url of ["https://collector.example.com/openai/v1", "http://res.openai.azure.com/openai/v1", "https://res.openai.azure.com.example.com/openai/v1", "https://user:pw@res.openai.azure.com/openai/v1"]) {
      const fetch = ok();
      const lines: string[] = [];
      const code = await listAzureDeployments({ env, fs: fsWith(`AZURE_FOUNDRY_URL=${url}\nAZURE_FOUNDRY_KEY=synthetic\n`), fetch, log: (l) => void lines.push(l) });
      expect(code).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(lines.join("\n")).not.toContain("synthetic");
    }
  });

  it("refuses a dotenv other users can read", async () => {
    const fetch = ok();
    const lines: string[] = [];
    const code = await listAzureDeployments({ env, fs: fsWith("AZURE_FOUNDRY_URL=https://res.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=synthetic\n", 0o100644), fetch, log: (l) => void lines.push(l) });
    expect(code).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(lines).toEqual(["listing failed: foundry_env_file_permissions_too_open"]);
  });

  it("lists from the checked Azure URL, follows no redirect, and prints neither host nor key", async () => {
    const fetch = ok();
    const lines: string[] = [];
    const code = await listAzureDeployments({ env, fs: fsWith("AZURE_FOUNDRY_URL=https://res.openai.azure.com/openai/v1/\nAZURE_FOUNDRY_KEY=synthetic\nAZURE_FAST_DEPLOYMENT=fast-1\n"), fetch, log: (l) => void lines.push(l) });
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://res.openai.azure.com/openai/deployments?api-version=2022-12-01");
    expect(init.redirect).toBe("error");
    expect(lines.join("\n")).not.toMatch(/synthetic|res\.openai\.azure\.com/);
    expect(lines).toContain("AZURE_FAST_DEPLOYMENT = fast-1");
  });

  it("marks only the gpt-live family as live: realtime, translation and live transcription are not voice session models", async () => {
    const names = ["gpt-live-1", "gpt-realtime-2.1", "gpt-realtime-translate", "gpt-live-transcribe", "gpt-5.6-luna"];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: names.map((id) => ({ id, model: id })) }), { status: 200 }));
    const lines: string[] = [];
    await listAzureDeployments({ env, fs: fsWith("AZURE_FOUNDRY_URL=https://res.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=synthetic\n"), fetch, log: (l) => void lines.push(l) });
    const kinds = Object.fromEntries(lines.filter((l) => l.startsWith("{")).map((l) => [JSON.parse(l).deployment, JSON.parse(l).kind]));
    expect(kinds).toEqual({
      "gpt-live-1": "live",
      "gpt-realtime-2.1": "realtime (not the live protocol)",
      "gpt-realtime-translate": "translation",
      "gpt-live-transcribe": "transcription",
      "gpt-5.6-luna": "chat",
    });
  });
});
