import "./prompt.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { DISCLOSURE_LAYER, debounce, draftFromSetup, errorWording, isDirty, isKebabCase, resetOverride, setOverride, toggleLayer } from "./logic";
import type { Direction, Draft, PreviewResult, SectionInfo, SetupsResponse } from "./types";

const wording = (err: unknown) => (err instanceof ApiError ? errorWording(err.code, err.status) : errorWording(undefined));
const EMPTY: Draft = { label: "", description: "", layers: [], personalityId: "", notes: "", overrides: {} };

export function PromptPanel() {
  const uid = useId();
  const [data, setData] = useState<SetupsResponse | null>(null);
  const [setupId, setSetupId] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [direction, setDirection] = useState<Direction>("inbound");
  const [lead, setLead] = useState("lead-1");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [naming, setNaming] = useState(false);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (pick?: string) => {
    try {
      const res = await api.list();
      setData(res);
      const id = pick ?? res.selectedId ?? res.setups[0]?.id ?? "";
      const setup = res.setups.find((s) => s.id === id) ?? res.setups[0];
      if (setup) { setSetupId(setup.id); setDraft(draftFromSetup(setup)); }
      setError("");
    } catch (err) { setError(wording(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const saved = data?.setups.find((s) => s.id === setupId);
  const dirty = isDirty(draft, saved);

  useEffect(() => {
    if (!setupId) return;
    let live = true;
    api.sections(setupId, direction).then((r) => { if (live) setSections(r.sections); }).catch((err) => { if (live) setError(wording(err)); });
    return () => { live = false; };
  }, [setupId, direction, saved]);

  // Live preview of the draft, about 600 milliseconds after the last change.
  const runPreview = useRef<ReturnType<typeof debounce<[Draft, string, Direction]>> | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    runPreview.current = debounce((d: Draft, l: string, dir: Direction) => {
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setPreviewBusy(true);
      api.preview(d, l, dir, ctl.signal)
        .then((r) => { setPreview(r); setPreviewError(""); })
        .catch((err) => { if (!(err instanceof DOMException)) setPreviewError(wording(err)); })
        .finally(() => { if (abort.current === ctl) setPreviewBusy(false); });
    }, 600);
    return () => { runPreview.current?.cancel(); abort.current?.abort(); };
  }, []);
  useEffect(() => { if (setupId) runPreview.current?.(draft, lead, direction); }, [draft, lead, direction, setupId]);

  const layerOrder = useMemo(() => data?.layers.map((l) => l.id) ?? [], [data]);
  const choose = (id: string) => {
    if (dirty && !window.confirm("You have unsaved changes. Switch setup and discard them?")) return;
    const s = data?.setups.find((x) => x.id === id);
    if (s) { setSetupId(id); setDraft(draftFromSetup(s)); setNotice(""); setError(""); setNaming(false); }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (err) { setError(wording(err)); } finally { setBusy(false); }
  };
  const save = () => run(async () => { await api.save(setupId, draft); await load(setupId); setNotice("Saved."); });
  const saveNew = () => run(async () => {
    if (!isKebabCase(newId)) throw new ApiError("invalid_id", 400);
    await api.save(newId, { ...draft, label: draft.label || newId });
    setNaming(false); setNewId(""); await load(newId); setNotice(`Saved as ${newId}.`);
  });
  const remove = () => run(async () => {
    if (!window.confirm(`Delete the setup "${saved?.label}"?`)) return;
    await api.remove(setupId); await load(); setNotice("Deleted.");
  });
  const use = () => run(async () => { const r = await api.select(setupId); setData((d) => (d ? { ...d, selectedId: r.selectedId } : d)); setNotice("This setup will be used for the next call."); });

  if (!data) return <div className="pp" role="status">{error ? <span className="pp-error">{error}</span> : "Loading prompt setups..."}</div>;
  const shipped = saved?.shipped ?? false;
  const fid = (n: string) => `${uid}-${n}`;
  const editable = sections.filter((s) => s.editable && s.id !== DISCLOSURE_LAYER && draft.layers.includes(s.id));
  const floor = sections.find((s) => s.id === "floor");

  return (
    <div className="pp">
      <div className="pp-row">
        <div className="pp-field">
          <label htmlFor={fid("setup")}>Setup</label>
          <select id={fid("setup")} className="pp-input" value={setupId} onChange={(e) => choose(e.target.value)}>
            {data.setups.map((s) => <option key={s.id} value={s.id}>{s.label}{s.shipped ? " (read only)" : ""}{s.id === data.selectedId ? " (in use)" : ""}</option>)}
          </select>
        </div>
        <div className="pp-field">
          <label htmlFor={fid("pers")}>Personality</label>
          <select id={fid("pers")} className="pp-input" value={draft.personalityId} onChange={(e) => setDraft({ ...draft, personalityId: e.target.value })}>
            {data.personalities.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="pp-field">
          <span id={fid("dir")}>Call direction</span>
          <div className="pp-seg" role="group" aria-labelledby={fid("dir")}>
            {(["inbound", "outbound"] as const).map((d) => <button key={d} type="button" aria-pressed={direction === d} onClick={() => setDirection(d)}>{d === "inbound" ? "Inbound" : "Outbound"}</button>)}
          </div>
        </div>
        <div className="pp-field">
          <label htmlFor={fid("lead")}>Lead id</label>
          <input id={fid("lead")} className="pp-input" style={{ width: 120 }} value={lead} onChange={(e) => setLead(e.target.value)} />
        </div>
        {dirty && <span className="pp-tag warn" role="status">Unsaved changes</span>}
        {shipped && <span className="pp-tag">Read only: use Save as new to keep changes</span>}
      </div>

      {saved?.description && <p className="pp-muted" style={{ margin: 0 }}>{saved.description}</p>}

      <div className="pp-row">
        <button className="pp-btn primary" onClick={save} disabled={busy || shipped || !dirty}>Save</button>
        <button className="pp-btn" onClick={() => setNaming((v) => !v)} disabled={busy} aria-expanded={naming}>Save as new</button>
        <button className="pp-btn danger" onClick={remove} disabled={busy || shipped}>Delete</button>
        <button className="pp-btn" onClick={use} disabled={busy || dirty || setupId === data.selectedId} title={dirty ? "Save first, the call uses the saved setup" : undefined}>Use for next call</button>
        {error && <span className="pp-error" role="alert">{error}</span>}
        {notice && <span className="pp-ok" role="status">{notice}</span>}
      </div>
      {naming && (
        <form className="pp-row" onSubmit={(e) => { e.preventDefault(); void saveNew(); }}>
          <div className="pp-field">
            <label htmlFor={fid("newid")}>New setup id (lower case words joined by hyphens)</label>
            <input id={fid("newid")} className="pp-input" value={newId} onChange={(e) => setNewId(e.target.value.trim())} placeholder="friendly-short" autoFocus />
          </div>
          <button className="pp-btn primary" type="submit" disabled={busy || !isKebabCase(newId)}>Save new setup</button>
        </form>
      )}

      <fieldset className="pp-card" style={{ margin: 0 }}>
        <legend className="pp-title">Layers included</legend>
        <div className="pp-layers">
          {data.layers.map((l) => {
            const locked = l.id === DISCLOSURE_LAYER;
            return (
              <label key={l.id}>
                <input type="checkbox" checked={locked || draft.layers.includes(l.id)} disabled={locked} onChange={(e) => setDraft(toggleLayer(draft, l.id, e.target.checked, layerOrder))} />
                {l.title}{locked ? " (locked)" : ""}
              </label>
            );
          })}
        </div>
      </fieldset>

      {floor && (
        <div className="pp-card">
          <div className="pp-head"><span className="pp-title">{floor.title}</span><span className="pp-tag">Locked</span></div>
          <div className="pp-locked">{floor.text}</div>
        </div>
      )}

      {editable.map((s) => {
        const value = draft.overrides[s.id] ?? s.defaultText;
        const overridden = s.id in draft.overrides;
        return (
          <div className="pp-card" key={s.id}>
            <div className="pp-head">
              <label className="pp-title" htmlFor={fid(`sec-${s.id}`)}>{s.title}</label>
              <span className="pp-row" style={{ gap: 8 }}>
                {overridden && <span className="pp-tag warn">Overridden</span>}
                <button type="button" className="pp-btn small" disabled={!overridden} onClick={() => setDraft(resetOverride(draft, s.id))}>Reset to default</button>
              </span>
            </div>
            <textarea id={fid(`sec-${s.id}`)} className="pp-text" value={value} onChange={(e) => setDraft(setOverride(draft, s.id, e.target.value, s.defaultText))} />
          </div>
        );
      })}

      <div className="pp-card">
        <div className="pp-head"><span className="pp-title">Disclosure</span><span className="pp-tag">Locked</span></div>
        <div className="pp-locked">{data.disclosure.text}</div>
        <span className="pp-muted">{data.disclosure.note} It stays word for word from the template, and edits cannot remove it.</span>
      </div>

      <div className="pp-card">
        <div className="pp-head">
          <span className="pp-title" id={fid("prev")}>Preview of the final instruction</span>
          <span className="pp-muted" aria-live="polite">{previewBusy ? "Updating..." : preview ? `About ${preview.approxTokens} tokens` : ""}</span>
        </div>
        {previewError && <span className="pp-error" role="alert">{previewError}</span>}
        <pre className="pp-preview" tabIndex={0} aria-labelledby={fid("prev")}>{preview?.text ?? "The preview appears here after the first update."}</pre>
        <span className="pp-muted">The lead context block for the chosen lead is at the end.</span>
      </div>
    </div>
  );
}
