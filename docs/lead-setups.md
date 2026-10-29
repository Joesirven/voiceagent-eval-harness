# Lead setups

A lead setup combines a lead, a voice module, a decision module, a prompt setup, and an optional caller persona. The Voice Agent Console resolves this combination before a call starts and stores a snapshot with the run.

The mock lead store is the default. It contains only fictional Northwind Insurance Agency records. A custom customer relationship management system can implement `LeadStore` on the server.

## Run records

`src/setups/run-writer.ts` writes a completed run through the configured run sink. The row can contain the setup snapshot, transcript, trace, judge verdicts, disposition, outcome, and handoff note. `supabase/harness/002_harness_run.sql` defines the harness table.

Write-back is optional. A failed database write does not change the call result because the local record remains the source for retry.

## Safety

- Never include a phone number or email address in the prompt context.
- Keep customer relationship management system credentials on the server.
- Make external writes opt-in and visible in the setup snapshot.
- Use synthetic leads for browser and simulation tests.
- Treat transcripts and traces as sensitive call content.
