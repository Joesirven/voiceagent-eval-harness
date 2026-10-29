import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { VoiceErrorRecord } from "@/lib/types";

/** Shows each new voice error once as a toast with its fix step, and keeps the recent ones in a side panel. */
export function useVoiceErrorToasts(errors: VoiceErrorRecord[] | undefined) {
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!errors) return;
    // Errors already in the list when the page first loads are in the panel, not re-announced.
    if (seen.current === null) { seen.current = new Set(errors.map((e) => e.id)); return; }
    for (const e of errors) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      const show = e.severity === "error" ? toast.error : toast.warning;
      show(e.title, { id: `voice-error-${e.id}`, description: `${e.detail} Fix: ${e.fix}`, duration: 15000 });
    }
  }, [errors]);
}

/** The recent errors, newest first, each with what to do about it. */
export function ErrorsList({ errors, className }: { errors: VoiceErrorRecord[]; className?: string }) {
  const list = [...errors].reverse();
  return (
    <div className={`grid gap-3 ${className ?? ""}`}>
      {list.length === 0 && <p className="text-sm text-muted-foreground">No errors so far.</p>}
      {list.map((e) => (
        <Alert key={e.id} variant={e.severity === "error" ? "destructive" : "default"}>
          <AlertTitle>{e.title}</AlertTitle>
          <AlertDescription className="grid gap-1">
            <span>{e.detail}</span>
            <span><strong>Fix:</strong> {e.fix}</span>
            <span className="text-xs text-muted-foreground">{e.canContinue ? "The call can continue." : "The call cannot continue."}{e.blocksNewCalls ? " New calls are blocked." : ""} {e.path} · {e.at.slice(11, 19)}</span>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

export function ErrorsPanel({ errors }: { errors: VoiceErrorRecord[] }) {
  const list = [...errors].reverse();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="relative size-8" id="openErrors" aria-label="Recent errors" title="Recent errors"><TriangleAlertIcon />{list.length > 0 && <Badge variant="destructive" className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[10px]">{list.length}</Badge>}</Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Recent errors</SheetTitle>
          <SheetDescription>Newest first, each with what to do about it.</SheetDescription>
        </SheetHeader>
        <ErrorsList errors={errors} className="px-4 pb-6" />
      </SheetContent>
    </Sheet>
  );
}
