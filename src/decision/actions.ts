/**
 * What each judged action does once the judge allows it. The engine calls
 * these only through the judge gate; nothing else in the decision module
 * writes, books, transfers or sends.
 */

import { toolBookProducer, toolSaveMessage } from "../tools/agent-tools.js";
import type { LeadStore } from "../store/lead-store-seam.js";
import { traceTool } from "../trace/events.js";

export interface ActionPort {
  transfer(reason: string): Promise<boolean>;
  saveQuoteField(field: string, value: string, evidenceSpan: string, callerTurns: string[]): Promise<boolean>;
  saveDetails(kind: string, body: string): Promise<boolean>;
  book(slotIso: string): Promise<boolean>;
  sendText(body: string): Promise<boolean>;
  endWithDisposition(disposition: string, durable: boolean): Promise<boolean>;
}

export interface ActionPortDeps {
  store: LeadStore;
  leadId: string;
  callId: string;
  /** The harness's own text path, with all its compliance checks and its idempotency. */
  sendText: (leadId: string, body: string, key: string) => Promise<{ status: string }>;
}

export function storeActionPort(deps: ActionPortDeps): ActionPort {
  const { store, leadId, callId } = deps;
  let texts = 0;
  return {
    // The mock has no real telephony to transfer on: the step is recorded, and the handoff note tells a person.
    transfer: (reason) => traceTool("transfer_to_human", { reason }, async () => true),
    saveQuoteField: (field, value, evidenceSpan, callerTurns) =>
      traceTool("write_quote_field", { field, value, evidenceSpan }, () =>
        store.writeQuoteField(leadId, field, value, evidenceSpan, callerTurns),
      ),
    saveDetails: async (kind, body) => {
      await toolSaveMessage(store, leadId, callId, body, kind);
      return kind.length > 0;
    },
    book: async (slotIso) => (await toolBookProducer(store, leadId, callId, slotIso)).booked,
    sendText: async (body) => {
      texts += 1;
      const result = await deps.sendText(leadId, body, `${callId}:text:${texts}`);
      return result.status === "recorded";
    },
    endWithDisposition: (disposition, durable) =>
      traceTool("record_disposition", { disposition, durable }, async () => true),
  };
}
