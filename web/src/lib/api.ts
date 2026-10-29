import { toast } from "sonner";

export function apiErrorMessage(json: any, res: Pick<Response, "status" | "statusText">): string {
  if (json && typeof json.reason === "string" && json.reason) return json.reason;
  if (json && typeof json.error === "string" && json.error) return json.error;
  if (json && typeof json.code === "string" && json.code) return json.code;
  if (json && json.blocked && typeof json.reason !== "string") return "blocked";
  return res.statusText && res.statusText !== "Conflict" ? res.statusText : `HTTP ${res.status}`;
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.blocked) throw new Error(apiErrorMessage(json, res));
  return json as T;
}

/** Runs an action and shows any failure as a toast instead of an inline error line. */
export async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** GET /api/voice/options: the orchestrators, voice paths and deployed models the sheet may offer. */
export async function fetchVoiceOptions(): Promise<import("./types").VoiceOptions> {
  const res = await fetch("/api/voice/options");
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON: fall through to the status text */ }
  if (!res.ok || !json || !Array.isArray(json.orchestrators)) throw new Error(apiErrorMessage(json, res));
  return json;
}
