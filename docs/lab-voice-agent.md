# Voice agent lab

The lab setup combines a natural insurance prompt, lead context, decision-tree guidance, and guarded tools. The example agency and every example lead are fictional.

At session start, the prompt builder joins the selected prompt with a lead context block. The context block excludes contact data. It can include known business facts, quote items, prior synthetic call summaries, and the number of days until renewal.

Every tool call goes through the flow dispatcher. Read-only tools can return data directly. A proposed write must include evidence from the caller and pass the action judge. External writes remain the responsibility of a custom customer relationship management system adapter.

The run writer stores the setup snapshot, transcript, trace, outcome, disposition, handoff note, and judge results after the call.
