import { collectFinalTranscript, eventsFromScript } from "../orchestration/call-loop.js";
import { OrchestrationError, type OrchestrationModule, type OrchestrationTransport } from "./contract.js";

/** Reuses the existing harness transcript ordering. Does not dial, clear gates, or write data. */
export class OwnInfrastructureModule implements OrchestrationModule {
  readonly id = "own-infrastructure" as const;
  capabilities() {
    return { moduleId: this.id, liveText: true, simulatorText: true, liveAudio: false,
      simulatorAudio: false, cancellation: true as const, gracefulEnd: true as const };
  }
  createTransport(): OrchestrationTransport {
    let open = false;
    return {
      async open(signal) { if (signal.aborted) throw new OrchestrationError("cancelled"); open = true; },
      async exchange(text, reply, signal) {
        if (!open || signal.aborted) throw new OrchestrationError("invalid_state");
        const answer = await reply(text);
        if (!open || signal.aborted) throw new OrchestrationError("cancelled");
        const turns = collectFinalTranscript(eventsFromScript([
          { role: "caller", text, turnIndex: 0 }, { role: "agent", text: answer, turnIndex: 1 },
        ]));
        return turns[1].text;
      },
      async close() { open = false; },
      async cancel() { open = false; },
    };
  }
}
