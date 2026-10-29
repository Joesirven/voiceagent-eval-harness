/**
 * The after-call queue. During a call nothing lasting is written to CRM
 * (Dana's decision of 2026-10-20): a queued_after_call tool the judge allowed
 * leaves one filing here, naming the CRM call it mirrors and the
 * credential that call needs, for the filer to run after the call. A tool that
 * needs a credential the harness does not hold leaves a follow-up for a producer.
 */

import type { FlowTool, FlowToolCredential } from "./catalog.js";

export interface AfterCallFiling {
  tool: string;
  /** The catalog's crmTarget: the exact CRM call the filer mirrors. */
  crmCall: string;
  credential: FlowToolCredential;
  /** The tool's arguments as the judge allowed them, the caller's quote included. */
  arguments: Record<string, string>;
  callId: string;
  leadId: string;
  at: string;
}

/** A request a licensed producer must handle, because the harness holds no credential for it. */
export interface ProducerFollowUp {
  tool: string;
  credential: FlowToolCredential;
  /** The arguments without the caller's quote, which only a filing carries. */
  arguments: Record<string, string>;
  at: string;
}

export function withoutQuote(args: Record<string, string>): Record<string, string> {
  const { evidence_quote: _quote, ...rest } = args;
  return rest;
}

export function filingFor(
  tool: FlowTool,
  args: Record<string, string>,
  ids: { callId: string; leadId: string },
  at: Date,
): AfterCallFiling {
  return {
    tool: tool.name,
    crmCall: tool.crmTarget,
    credential: tool.credential,
    arguments: { ...args },
    callId: ids.callId,
    leadId: ids.leadId,
    at: at.toISOString(),
  };
}

export function followUpFor(tool: FlowTool, args: Record<string, string>, at: Date): ProducerFollowUp {
  return { tool: tool.name, credential: tool.credential, arguments: withoutQuote(args), at: at.toISOString() };
}
