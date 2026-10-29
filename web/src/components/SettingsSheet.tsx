import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { act, api } from "@/lib/api";
import type { AppState } from "@/lib/types";

export { VOICE_MODULE_ID } from "@/components/settings-controls";
/** Sent with every settings change so the server can log where it came from. */
const SETTINGS_SOURCE = "settings-sheet";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-b px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The environment switches in a side panel. What answers a call (orchestrator, voice path, models, barge-in and
 * decisions) is chosen in the call setup that opens from Play, right before each call.
 */
export function SettingsSheet({ state, refresh }: { state: AppState; refresh: (s?: AppState) => Promise<void> }) {
  const post = (url: string, body: object) => act(async () => refresh(await api(url, { ...body, source: SETTINGS_SOURCE })));
  return (
    <Sheet>
      <SheetTrigger asChild><Button variant="outline" size="icon" className="size-8" id="openSettings" aria-label="Settings" title="Settings"><SettingsIcon /></Button></SheetTrigger>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-sm" id="stackControls"
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
        <SheetHeader className="pb-2">
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>The environment the calls run in. The voice and decisions are chosen when you press Play.</SheetDescription>
        </SheetHeader>
        <Group title="Environment">
          {state.agencies.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3">
              <Label htmlFor={`flag-${a.id}`} className="grid gap-0.5 font-normal">
                <span className="text-sm font-medium">AI calling for {a.id}</span>
                <span className="text-xs text-muted-foreground">{a.aiCallingEnabled ? "On: the AI answers new calls." : "Off: calls get normal answering."}</span>
              </Label>
              <Switch id={`flag-${a.id}`} checked={a.aiCallingEnabled} onCheckedChange={(enabled) => post("/api/flag", { agencyId: a.id, enabled })} />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Lead data comes from the configured server-side store. The public default uses fictional leads.</p>
        </Group>
      </SheetContent>
    </Sheet>
  );
}
