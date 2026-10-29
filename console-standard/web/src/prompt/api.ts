import { buildPreviewBody, buildSetupBody } from "./logic";
import type { Direction, Draft, PreviewResult, PromptSetup, SectionInfo, SetupsResponse } from "./types";

/** A failed request: the server's error code (or "network") and the HTTP status. */
export class ApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

async function call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, signal, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("network", 0);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new ApiError(typeof json?.error === "string" ? json.error : `http_${res.status}`, res.status);
  return json as T;
}

const enc = encodeURIComponent;
export const api = {
  list: () => call<SetupsResponse>("GET", "/api/prompt-setups"),
  sections: (id: string, direction: Direction) => call<{ sections: SectionInfo[] }>("GET", `/api/prompt-setups/${enc(id)}/sections?direction=${direction}`),
  save: (id: string, draft: Draft) => call<PromptSetup>("PUT", `/api/prompt-setups/${enc(id)}`, buildSetupBody(draft)),
  remove: (id: string) => call<unknown>("DELETE", `/api/prompt-setups/${enc(id)}`),
  select: (id: string) => call<{ selectedId: string }>("POST", `/api/prompt-setups/${enc(id)}/select`, {}),
  preview: (draft: Draft, lead: string, direction: Direction, signal?: AbortSignal) =>
    call<PreviewResult>("POST", "/api/prompt-setups/preview", buildPreviewBody(draft, lead, direction), signal),
};
