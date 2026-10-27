---
name: business-follow-through
description: Finish delegated business work using durable tasks, current source evidence, bounded follow-ups and truthful outcome verification. Applies to research, documents, client requests and meeting preparation, not only quotes.
---

# Business follow-through

Use the existing bound task, objective and done criteria. Never create independent memory-based task state or treat a plan as completed work.

- Read the current checkpoint, profile facts and task sources. Retrieve only relevant source chunks with `knowledge_search`; preserve source/version/location in results.
- Resolve contested facts with `business_fact`. Missing recipients, prices, tax, durations, timezone, authority or contradictory documents are real blockers. Use the task missing-information wait and ask one question. Unrelated work can continue.
- Ordinary authorized sends, bookings, app actions and hosted computer work do not need routine owner approval. Respect explicit constraints, provider challenges, disconnected accounts, task cancellation and global stop.
- Before a chase or invitation, re-read the current thread, task, source revisions, owner interventions, opt-outs and availability. A new reply or cancelled premise suppresses the old chase.
- Schedule durable waits, not a sleeping model call. Default to at most two unanswered chases separated by 72 elapsed hours, shifted into configured business contact hours. Downtime causes one fresh premise check, never a burst of missed messages.
- For research, provide actual source links and distinguish evidence from conclusions. For meeting preparation, use current participants, agenda, mailbox and calendar state without inventing facts.
- For documents, use bounded local files and `create_pdf`; office formats come from LibreOffice on the separately hosted computer. Transfer only task-required files. Never use controller host bash in business mode.
- Register completed files with `artifact_register`, including expected text and checked totals. It stores a new immutable version and reads the actual extracted content. An extraction failure or mismatch is not a completed deliverable. Open final office documents on the hosted computer and inspect the layout before calling them ready.
- Preserve owner-edited originals. Link opaque artifact IDs, hashes and source references, not controller paths. Do not promote a generated summary or image interpretation into standing policy.
- Inspect actual action evidence with `task_inspect`. A tool receipt does not prove the business outcome. Gmail readback proves sent in Gmail, not recipient delivery/read. Generic browser or shell uncertainty remains uncertainty and is never blindly replayed.
- Checkpoint useful progress. Complete only with `task_finish`, mapping every done criterion to actual verified action/artifact/source evidence. If an external outcome remains unknown, persist reconciliation or a visible blocker instead.
