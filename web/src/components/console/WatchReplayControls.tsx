import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { act } from "@/lib/api";
import { liveView } from "@/lib/live";
import type { CallViewModel } from "@/lib/use-call-view";

const NEWEST = "__newest__";

/** Pick which call to watch, or step through a stored call. Used by the Call tab dialog and the tree pane. */
export function WatchReplayControls({ model }: { model: Pick<CallViewModel, "pinned" | "setPinned" | "callIds" | "replay"> }) {
  const { pinned, setPinned, callIds, replay } = model;
  const { data, records } = replay;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={data ? NEWEST : (pinned && callIds.includes(pinned) ? pinned : NEWEST)} onValueChange={(v) => { replay.stop(); setPinned(v === NEWEST ? null : v); }}>
        <SelectTrigger id="watch" aria-label="Watch call" className="w-64"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NEWEST}>Follow the newest call</SelectItem>
          {callIds.map((id) => {
            const first = [...liveView.events.values()].find((e: any) => e.callId === id) as any;
            return <SelectItem key={id} value={id}>{`${first?.leadLabel ?? first?.leadId ?? "?"} ${first?.direction ?? ""} ${id.slice(-6)}`}</SelectItem>;
          })}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" id="watchReplay" onClick={() => (data ? replay.stop() : void replay.start())}>{data ? "Stop replay" : "Replay"}</Button>
      {records && !records.length && <span className="text-sm text-muted-foreground">No stored calls yet.</span>}
      {records && records.length > 0 && (
        <Select value={replay.recordId} onValueChange={(id) => act(() => replay.load(id))}>
          <SelectTrigger id="replayPick" aria-label="Stored call" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {records.map((r) => <SelectItem key={r.recordId} value={r.recordId}>{`${r.leadId} ${r.direction ?? ""} ${String(r.openedAt).slice(0, 19)}`}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {data && (
        <>
          <Button variant="outline" size="sm" id="stepBack" onClick={replay.stepBack}>Back</Button>
          <Button variant="outline" size="sm" id="stepNext" onClick={replay.stepNext}>Step</Button>
          <Button variant="outline" size="sm" id="stepAll" onClick={replay.stepAll}>All</Button>
          <span className="text-sm text-muted-foreground">{replay.step} of {data.events.length} events</span>
        </>
      )}
    </div>
  );
}
