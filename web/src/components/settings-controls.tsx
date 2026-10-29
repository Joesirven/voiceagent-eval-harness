// The controls of the call setup: a labelled dropdown, the voice options loader and the voice steps (voice path, then
// each model slot of the chosen path). Element ids are kept from the settings panel they came from.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { act, api, fetchVoiceOptions } from "@/lib/api";
import { describe, modelRoleLabels, providerLabels, unavailableReasonText } from "@/lib/labels";
import type { AppState, Choice, ModelRole, VoiceOptions } from "@/lib/types";

export const VOICE_MODULE_ID = "azure-gpt-live";
/** Sent with every setup change so the server can log where it came from. */
export const SETUP_SOURCE = "call-setup";

export interface Option { value: string; name: string; description?: string; disabled?: boolean }

/** A labelled dropdown whose options each have a short name and a one-line description. */
export function Field({ id, label, value, options, onChange, onPickCurrent, note }: {
  id: string; label: string; value: string | undefined; options: Option[]; onChange: (v: string) => void;
  /** Called when the already-shown value is picked again (the select itself reports no change then). */
  onPickCurrent?: () => void; note?: ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  const [open, setOpen] = useState(false);
  // The pointer type of a press that started on the already-shown item; a release with no such press (the one that ends the opening click) must not pick it.
  const pressed = useRef<string | null>(null);
  // A closed select picks the next matching item on one printable keypress and saves it at once; only opening it may choose.
  const swallowTypeahead = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); }
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange} open={open} onOpenChange={setOpen}>
        <SelectTrigger id={id} aria-label={label} className="h-8 w-full min-w-0" onKeyDown={swallowTypeahead}><SelectValue placeholder="Choose">{current?.name ?? (value || undefined)}</SelectValue></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled} textValue={o.name}
              onPointerDown={o.value === value && onPickCurrent ? (e) => { pressed.current = e.pointerType; } : undefined}
              onPointerLeave={o.value === value && onPickCurrent ? () => { pressed.current = null; } : undefined}
              onPointerUp={o.value === value && onPickCurrent ? (e) => { if (e.pointerType === "mouse" && pressed.current === "mouse") { pressed.current = null; onPickCurrent(); } } : undefined}
              onClick={o.value === value && onPickCurrent ? () => { const type = pressed.current; pressed.current = null; if (type !== null && type !== "mouse") onPickCurrent(); } : undefined}
              onKeyDown={o.value === value && onPickCurrent ? (e) => { if (e.key === "Enter" || e.key === " ") onPickCurrent(); } : undefined}>
              <span className="grid text-left">
                <span>{o.name}</span>
                {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(current?.description || note) && <p className="text-xs text-muted-foreground">{note ?? current?.description}</p>}
    </div>
  );
}

export function choices(kind: "orchestrator" | "voicePath" | "staleDrop", list: Choice[], selected: string): Option[] {
  return list.map((c) => {
    const d = describe(kind, c.id, c.label);
    const down = c.available === false;
    return { value: c.id, name: d.name, description: down ? (c.unavailableReason || "Unavailable right now.") : d.description, disabled: down && c.id !== selected };
  });
}

/** Loads GET /api/voice/options; a failed reload keeps the last good answer and reports why. */
export function useVoiceOptions() {
  const [options, setOptions] = useState<VoiceOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setOptions(await fetchVoiceOptions()); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { options, loadError, reload };
}

export type Post = (url: string, body: object) => Promise<void>;

/**
 * The voice settings for the orchestrator already chosen: its voice paths, then each slot of the chosen path.
 * A step stays hidden until the one before it is chosen, and choosing an earlier step puts the later ones back to their defaults.
 */
export function VoiceSteps({ state, options, loadError, routedModel, routedVoice, modelWarning, post, reload, refresh }: {
  state: AppState; options: VoiceOptions | null; loadError: string | null; routedModel: string; routedVoice: string; modelWarning?: string; post: Post; reload: () => Promise<void>; refresh: (s?: AppState) => Promise<void>;
}) {
  // Slot choices made since the last change to an earlier step; anything absent falls back to the slot default.
  const [slotModels, setSlotModels] = useState<Partial<Record<ModelRole, string>>>({});
  const [slotVoices, setSlotVoices] = useState<Partial<Record<ModelRole, string>>>({});
  const resetSlots = () => { setSlotModels({}); setSlotVoices({}); };

  const sourceNotes = (options?.sources ?? []).filter((s) => !s.ok).map((s) => `${providerLabels[s.provider] ?? s.provider} models could not be loaded: ${s.detail || "no reason given"}`);
  const notes = [...(loadError ? [`Voice options could not be loaded: ${loadError}`] : []), ...sourceNotes];
  const status = notes.length > 0 && (
    <div id="voiceOptionsStatus" role="status" className="grid gap-1 text-xs text-destructive">
      {notes.map((n) => <p key={n}>{n}</p>)}
      <Button variant="outline" size="sm" className="h-7 w-fit" onClick={() => void reload()}>Try again</Button>
    </div>
  );
  /** Sends one slot choice to the server, then rereads the options and the state so every field shows what the server holds. */
  const choose = (voicePathId: string, role: ModelRole, modelId: string, voice: string | undefined, onAccepted: () => void) => act(async () => {
    try {
      await api("/api/voice/path-models", { voicePathId, role, modelId, ...(voice ? { voice } : {}), source: SETUP_SOURCE });
      onAccepted();
    } finally {
      await reload();
      await refresh().catch(() => {});
    }
  });
  if (!options) return <>{status || <p className="text-xs text-muted-foreground">Loading what is available…</p>}</>;

  const orchestrator = options.orchestrators.find((o) => o.id === state.selectedOrchestratorId);
  const path = orchestrator?.voicePaths.find((p) => p.id === state.selectedVoicePathId);
  const known = (kind: "voicePath", id: string, label: string): Option => {
    const d = describe(kind, id, label);
    return { value: id, name: d.name, description: d.description };
  };
  // A path that cannot run is left out of the options; show it disabled with the reason, so the picker says why it is missing.
  const offered = new Set(options.orchestrators.flatMap((o) => o.voicePaths.map((p) => p.id)));
  const unavailablePaths: Option[] = state.voicePaths
    .filter((c) => c.available === false && !offered.has(c.id))
    .map((c) => ({ value: c.id, name: describe("voicePath", c.id, c.label).name, description: unavailableReasonText(c.unavailableReason), disabled: true }));

  /**
   * Puts the Azure gpt-live model back to the slot default. Only that path stores its model on the azure-gpt-live
   * module; the other paths keep their slot choices through POST /api/voice/path-models, so there is nothing to reset.
   */
  const resetStored = (p: NonNullable<typeof path>) => {
    if (p.id !== "azure_gpt_live") return;
    const slot = p.slots.find((s) => s.role === "speech_to_speech");
    const model = slot?.models.find((m) => m.id === slot.defaultId) ?? slot?.models[0];
    if (model) void post(`/api/modules/${VOICE_MODULE_ID}`, { model: model.id, voice: model.voices?.[0] }).then(() => reload());
  };

  return (
    <>
      {status}
      {orchestrator && (
        <Field id="stackVoicePath" label="Voice path" value={path?.id}
          options={[...orchestrator.voicePaths.map((p) => known("voicePath", p.id, p.label)), ...unavailablePaths]}
          onChange={(v) => {
            resetSlots();
            const next = orchestrator.voicePaths.find((p) => p.id === v);
            void post("/api/voice/path", { voicePathId: v }).then(() => { if (next) resetStored(next); });
          }} />
      )}
      {path && path.slots.map((slot) => {
        // Only the Azure gpt-live model is stored on the azure-gpt-live module; every other slot reads its choice from the options.
        const stored = path.id === "azure_gpt_live" && slot.role === "speech_to_speech";
        const ids = slot.models.map((m) => m.id);
        const chosenId = [slot.selectedId, slotModels[slot.role], stored ? routedModel : undefined, slot.defaultId, ids[0]].find((id) => id !== undefined && ids.includes(id));
        const chosen = slot.models.find((m) => m.id === chosenId);
        const voices = chosen?.voices ?? [];
        const voiceId = [slot.selectedVoice, slotVoices[slot.role], stored ? routedVoice : undefined, voices[0]].find((v) => v !== undefined && voices.includes(v));
        const label = modelRoleLabels[slot.role] ?? slot.role;
        if (slot.models.length === 0) return <p key={slot.role} className="text-xs text-muted-foreground">{label}: no deployed model is available right now.</p>;
        const blocked = stored && modelWarning !== undefined;
        return (
          <div key={slot.role} className="grid min-w-0 grid-cols-1 gap-3">
            <Field id={`stackSlot-${slot.role}`} label={label} value={chosenId}
              note={blocked ? <span role="alert" className="text-destructive">{modelWarning}</span> : undefined}
              options={slot.models.map((m) => ({ value: m.id, name: m.label, description: providerLabels[m.provider] }))}
              onPickCurrent={blocked && chosenId ? () => void choose(path.id, slot.role, chosenId, voiceId, () => {}) : undefined}
              onChange={(v) => {
                const m = slot.models.find((x) => x.id === v);
                void choose(path.id, slot.role, v, m?.voices?.[0], () => {
                  setSlotModels((s) => ({ ...s, [slot.role]: v })); setSlotVoices((s) => { const { [slot.role]: _drop, ...rest } = s; return rest; });
                });
              }} />
            {voices.length > 0 && chosenId && (
              <Field id={`stackSlotVoice-${slot.role}`} label={`Voice for ${label.toLowerCase()}`} value={voiceId}
                options={voices.map((v) => ({ value: v, name: v }))}
                onChange={(v) => { void choose(path.id, slot.role, chosenId, v, () => setSlotVoices((s) => ({ ...s, [slot.role]: v }))); }} />
            )}
          </div>
        );
      })}
    </>
  );
}
