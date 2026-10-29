import { LeadState } from "./LeadState";
import { useState } from "react";
import { ENDPOINTING_VALUES, VAD_STOP_VALUES, type Choice, type Config, type Options } from "./options";

export type { Config, Options } from "./options";

export interface ConfigPanelProps {
  configs: Config[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSaved: (c: Config) => void;
  options?: Options;
  disabled?: boolean;
  working?: Config;
  onChange?: (patch: Partial<Config>) => void;
  /** The latest save_quote_field tool event of the current call, for the lead state card. */
  savedField?: { field: string; value: unknown; seq: number };
}

const FIELD = "config-field";

/** Adds the current value to a list when it is not one of the offered choices (for example a saved voice), so it never silently changes. */
function withCurrent<T extends string | number>(list: Choice<T>[], current: T, label: (v: T) => string): Choice<T>[] {
  return list.some((c) => c.id === current) ? list : [{ id: current, label: label(current), description: "" }, ...list];
}

function Select<T extends string | number>({ id, label, value, choices, disabled, onPick }: {
  id: string; label: string; value: T; choices: Choice<T>[]; disabled?: boolean; onPick: (v: T) => void;
}) {
  const current = choices.find((c) => c.id === value);
  const hintId = `${id}-hint`;
  return (
    <div className="config-row">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className={FIELD}
        value={String(value)}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(e) => { const hit = choices.find((c) => String(c.id) === e.target.value); if (hit && hit.available !== false) onPick(hit.id); }}
      >
        {choices.map((c) => (
          <option key={String(c.id)} value={String(c.id)} disabled={c.available === false} title={c.description}>
            {c.label}{c.available === false ? ` (unavailable: ${c.reason ?? "not available"})` : ""}
          </option>
        ))}
      </select>
      <span id={hintId} className="config-hint">{current?.description}</span>
    </div>
  );
}

/** The configuration panel: a preset list, one choice per setting, and Save as new. Edits change only the working copy. */
export function ConfigPanel({ configs, selectedId, onSelect, onSaved, options, disabled, working, onChange, savedField }: ConfigPanelProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const preset = configs.find((c) => c.id === selectedId);
  const current = working ?? preset;

  const save = async () => {
    if (!current) return;
    setError("");
    const { id, ...settings } = current;
    try {
      const res = await fetch("/configs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...settings, name }) });
      const json = await res.json();
      if (!res.ok) { setError(json.error === "name_taken" ? "That name is used by a built-in configuration." : `Not saved: ${json.error}`); return; }
      onSaved(json.config);
      setSaving(false);
      setName("");
    } catch {
      setError("Not saved: the page server did not answer.");
    }
  };

  const set = (patch: Partial<Config>) => onChange?.(patch);
  const idNumberLabel = (suffix: string) => (v: number) => `${v} ${suffix}`;

  return (
    <section className="config-panel" aria-label="Configuration">
      <div className="config-row">
        <label htmlFor="config-select">Preset</label>
        <select id="config-select" className={FIELD} value={selectedId} disabled={disabled} onChange={(e) => onSelect(e.target.value)} aria-describedby="config-select-hint">
          {configs.map((c) => <option key={c.id} value={c.id} title={c.note}>{c.name}</option>)}
        </select>
        <span id="config-select-hint" className="config-hint">{preset?.note ?? "Saved and built-in configurations."}</span>
      </div>
      {options && current ? (
        <>
          <Select id="cfg-voice-path" label="Voice path" value={current.voicePath} choices={withCurrent(options.voicePaths, current.voicePath, (v) => v)} disabled={disabled} onPick={(v) => set({ voicePath: v })} />
          <Select id="cfg-stt" label="Speech to text model" value={current.sttModel} choices={withCurrent(options.sttModels, current.sttModel, (v) => v)} disabled={disabled} onPick={(v) => set({ sttModel: v })} />
          <Select id="cfg-reply" label="Reply model" value={current.replyDeployment} choices={withCurrent(options.replyDeployments, current.replyDeployment, (v) => v)} disabled={disabled} onPick={(v) => set({ replyDeployment: v })} />
          <Select id="cfg-voice" label="Voice" value={current.voice} choices={withCurrent(options.voices, current.voice, (v) => v)} disabled={disabled} onPick={(v) => set({ voice: v })} />
          <Select id="cfg-endpointing" label="Turn timing: endpointing" value={current.endpointingMs} choices={withCurrent(options.endpointingMs.length ? options.endpointingMs : ENDPOINTING_VALUES.map((v) => ({ id: v, label: `${v} ms`, description: "" })), current.endpointingMs, idNumberLabel("ms"))} disabled={disabled} onPick={(v) => set({ endpointingMs: v })} />
          <Select id="cfg-vad" label="Turn timing: voice detection stop" value={current.vadStopSecs} choices={withCurrent(options.vadStopSecs.length ? options.vadStopSecs : VAD_STOP_VALUES.map((v) => ({ id: v, label: `${v} s`, description: "" })), current.vadStopSecs, idNumberLabel("s"))} disabled={disabled} onPick={(v) => set({ vadStopSecs: v })} />
          <Select id="cfg-orchestration" label="Orchestration" value={current.orchestration} choices={withCurrent(options.orchestrations, current.orchestration, (v) => v)} disabled={disabled} onPick={(v) => set({ orchestration: v })} />
          <Select id="cfg-prompt" label="Prompt setup" value={current.promptSetup} choices={withCurrent(options.promptSetups, current.promptSetup, (v) => v)} disabled={disabled} onPick={(v) => set({ promptSetup: v })} />
          <Select id="cfg-lead" label="Lead" value={current.lead} choices={withCurrent(options.leads, current.lead, (v) => v)} disabled={disabled} onPick={(v) => set({ lead: v })} />
          <Select id="cfg-direction" label="Direction" value={current.direction} choices={withCurrent(options.directions, current.direction, (v) => v)} disabled={disabled} onPick={(v) => set({ direction: v })} />
        </>
      ) : (
        <p className="config-hint">Loading choices.</p>
      )}
      <p className="config-note">Changes apply on the next Connect.</p>
      <div className="config-save">
        {saving ? (
          <>
            <label className="sr-only" htmlFor="config-name">Name for the new configuration</label>
            <input id="config-name" className={FIELD} placeholder="Name this configuration" value={name} maxLength={40} disabled={disabled} onChange={(e) => setName(e.target.value)} />
            <button className={FIELD} disabled={disabled || !name.trim()} onClick={save}>Save</button>
            <button className={FIELD} disabled={disabled} onClick={() => { setSaving(false); setError(""); }}>Cancel</button>
          </>
        ) : (
          <button className={FIELD} disabled={disabled || !current} onClick={() => setSaving(true)} title="Save the chosen settings under a new name">Save as new</button>
        )}
        {error && <span className="config-error" role="alert">{error}</span>}
      </div>
      <LeadState lead={(working ?? configs.find((c) => c.id === selectedId))?.lead ?? "lead-1"} savedField={savedField} />
    </section>
  );
}
