import { describe, expect, it } from "vitest";
import { micAccessIssue, micEnvironmentHint } from "../../src/server/voice/mic-environment.js";

describe("mic environment", () => {
  it("blocks remote HTTP hosts that are not a secure context", () => {
    const issue = micAccessIssue({
      hostname: "test-host.example.ts.net",
      host: "test-host.example.ts.net:4311",
      port: "4311",
      isSecureContext: false,
    });
    expect(issue).toMatch(/Microphone blocked/);
    expect(issue).toMatch(/127\.0\.0\.1:4311/);
    expect(issue).toMatch(/Remote HTTP cannot use the mic/);
  });

  it("allows loopback HTTP", () => {
    expect(
      micAccessIssue({
        hostname: "127.0.0.1",
        host: "127.0.0.1:4311",
        port: "4311",
        isSecureContext: false,
      }),
    ).toBeNull();
  });

  it("hints direct Azure on a good host", () => {
    expect(micEnvironmentHint({ hostname: "127.0.0.1", host: "127.0.0.1:4311", port: "4311", isSecureContext: false })).toMatch(
      /Direct Azure/,
    );
  });
});
