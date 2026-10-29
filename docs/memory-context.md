# Lead memory and context

The harness separates three kinds of state.

- Lead memory contains durable facts supplied by the `LeadStore` implementation.
- Call state contains facts and decisions collected during one call.
- A handoff note summarizes supported facts and the next action after the call.

The prompt builder omits contact data. It also labels unknown values as unknown. A fact becomes durable only after a guarded write accepts caller evidence.

The default mock store supplies fictional records. To connect another customer relationship management system, implement `LeadStore` on the server. The adapter must define its read and write policy. It must not expose credentials to the browser.
