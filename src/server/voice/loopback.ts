import type { IncomingMessage } from "node:http";

/** Extra exact host names (with port when not the default) from HARNESS_ALLOWED_HOSTS, comma separated. Unset means loopback only. */
function extraHosts(): string[] {
  return (process.env.HARNESS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * Guard against a web page the user visits poking the local API: Host must be
 * loopback on this server's own port (or one of the exact names in
 * HARNESS_ALLOWED_HOSTS, for a private proxy in front of this server), and any
 * Origin must match the same host. Used for plain requests and websocket upgrades.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const port = req.socket.localPort;
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowed = [...loopback, ...extraHosts()];
  const host = req.headers.host?.toLowerCase();
  if (!host || !allowed.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const origins = [
    ...loopback.map((h) => `http://${h}`),
    ...extraHosts().flatMap((h) => [`https://${h}`, `http://${h}`]),
  ];
  return origins.includes(origin.toLowerCase());
}
