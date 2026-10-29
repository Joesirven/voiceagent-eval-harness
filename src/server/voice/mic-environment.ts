/**
 * Browser microphone rules shared with the Talk client. getUserMedia needs a
 * secure context: HTTPS, or HTTP on localhost / 127.0.0.1 on the same machine
 * as the tab. A remote HTTP host (for example a tailnet name) cannot capture audio.
 */

export type MicLocation = { hostname: string; host: string; port: string; isSecureContext: boolean };

export function micAccessIssue(loc: MicLocation): string | null {
  const local =
    loc.hostname === "localhost" || loc.hostname === "127.0.0.1" || loc.hostname === "[::1]";
  if (!loc.isSecureContext && !local) {
    const port = loc.port || "4311";
    return `Microphone blocked: open http://127.0.0.1:${port}/ on the machine running the harness (not ${loc.host}). Remote HTTP cannot use the mic; use bb connect expose and HTTPS, or SSH port-forward 127.0.0.1:${port}.`;
  }
  return null;
}

export function micEnvironmentHint(loc: MicLocation): string {
  const issue = micAccessIssue(loc);
  if (issue) return issue;
  const port = loc.port || "4311";
  return `Talk microphone works at http://127.0.0.1:${port}/ on this host. Stack → Orchestrator → Direct Azure skips Pipecat if relay audio is broken.`;
}
