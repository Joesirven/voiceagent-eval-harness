import { useEffect, useState } from "react";

/** One field of what the quote needs. */
export interface LeadField { field: string; label: string; value?: string | number | null }

/** Turns the harness answer into known and missing lists. Accepts a few plain shapes, since the route is new. */
export function parseLeadState(body: any): { known: LeadField[]; missing: LeadField[] } {
  const list = (x: any): LeadField[] =>
    Array.isArray(x)
      ? x.map((f: any) => (typeof f === "string" ? { field: f, label: f } : { field: String(f.field ?? f.id ?? f.name ?? f.label), label: String(f.label ?? f.name ?? f.field ?? f.id), value: f.value ?? null }))
      : x && typeof x === "object"
        ? Object.entries(x).map(([k, v]) => ({ field: k, label: k, value: v as any }))
        : [];
  const known = list(body?.known ?? body?.have ?? body?.fields?.known);
  let missing = list(body?.missing ?? body?.needed ?? body?.fields?.missing);
  // The harness sends missing field ids with their plain labels alongside.
  if (Array.isArray(body?.missingLabels)) missing = missing.map((f, i) => ({ ...f, label: String(body.missingLabels[i] ?? f.label) }));
  return { known, missing };
}

/** Marks a field as known when a save_quote_field tool event arrives during a call. */
export function applySavedField(state: { known: LeadField[]; missing: LeadField[] }, field: string, value: unknown) {
  const label = state.missing.find((f) => f.field === field)?.label ?? state.known.find((f) => f.field === field)?.label ?? field;
  return {
    known: [...state.known.filter((f) => f.field !== field), { field, label, value: value as any }],
    missing: state.missing.filter((f) => f.field !== field),
  };
}

/** Lead state: what we know about the lead and what the quote still needs. */
export function LeadState({ lead, savedField }: { lead: string; savedField?: { field: string; value: unknown; seq: number } }) {
  const [state, setState] = useState<{ known: LeadField[]; missing: LeadField[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setState(null);
    setError("");
    fetch(`/api/lead-context/state?leadId=${encodeURIComponent(lead)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the harness answered ${r.status}`))))
      .then((b) => setState(parseLeadState(b)))
      .catch((e) => setError(e instanceof Error ? e.message : "not available"));
  }, [lead]);
  useEffect(() => {
    if (savedField) setState((s) => applySavedField(s ?? { known: [], missing: [] }, savedField.field, savedField.value));
  }, [savedField?.seq]);

  return (
    <section className="lead-state" aria-label="Lead state">
      <h3>Lead state</h3>
      {error && !state && <p className="lead-state-note">Not available yet: {error}.</p>}
      {state && (
        <>
          <h4>Known</h4>
          <ul>{state.known.length ? state.known.map((f) => <li key={f.field}><span>{f.label}</span>: {String(f.value ?? "")}</li>) : <li>Nothing yet.</li>}</ul>
          <h4>Missing for the quote</h4>
          <ul>{state.missing.length ? state.missing.map((f) => <li key={f.field}>{f.label}</li>) : <li>Nothing missing.</li>}</ul>
        </>
      )}
    </section>
  );
}
