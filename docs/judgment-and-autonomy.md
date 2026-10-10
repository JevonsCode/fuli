# Tonborg and autonomy

Tonborg is the built-in judgment Agent, alongside Jefa and Bole. It has a persistent FLA identity, scoped Agent memory, and a native decision workbench. All Agents can be pinned from their card; pins appear in navigation. The three built-in roles are the initial defaults. Removing a pin, including every pin, survives reloads.

## Choose the amount of autonomy

Settings offers three choices, saved immediately with Undo:

- **I decide**: Tonborg analyzes and records suggestions.
- **Shared decisions**: Tonborg applies routine knowledge reviews backed by existing confirmation and accepts verified FULI tasks.
- **Autonomous**: Tonborg may also review ordinary pending knowledge. Conflicts, sensitive preferences, uncertain evidence, and actions outside existing authority remain for the user.

Projects inherit the global policy unless the user sets an exception. Updating FULI does not silently expand existing authority. The selected local client runs the judgment, and quality preference controls its reasoning effort. Logs show the actual model only when the client reports it.

## What a decision does

Knowledge review uses bounded batches and an independent review ledger. A successful assessment appears as **Tonborg reviewed**. It does not change human confirmation, authoritative-source confirmation, publication eligibility, or the original evidence. The Provider compares an evidence snapshot within the write transaction; edited or conflicted knowledge loses its effective AI-reviewed disposition. A failing item cannot block the rest of the queue.

`assess_agent_action` recommends continuing the current conversation, reusing an authorized conversation, opening a session, or delegating work. It selects only registered, authorized, preflighted executors and available models that satisfy the Agent, assignment, task, and user routing constraints. The host performs and reports the actual launch or resumption. Conversation history is supplied only to a judgment client permitted for that Agent.

`assess_task_completion` is called by the accountable lead with its current task context, exact task revision, and artifact revision. Automatic acceptance requires a passed real verification by another Agent. The Provider rechecks the current lead context, task revision, artifact, and verified attempt before completing the FULI task. Jefa's separate human acceptance, publication, permissions, and payments retain their existing boundaries.

The console processes bounded automatic review batches while running. Manual review is available in Tonborg's workbench. Other MCP processes share the same local policy and decision database without starting duplicate schedulers. A lease prevents simultaneous decisions for the same project.

## Correct a judgment

Use thumbs up or thumbs down with an optional reason. A vote takes one click; reasons can be changed or cleared. The original decision, execution receipts, and feedback history remain auditable. Relevant feedback includes the selected client/model and work kind, so a reasonless vote still identifies the choice being evaluated. Feedback is scoped evidence for later decisions, not a new universal instruction or automatic reversal of an action.

Tonborg uses only its own scoped memory and authorized evidence. Client failure, malformed output, stale evidence, or missing authority produces a visible failure or escalation rather than a successful execution claim. Its judgment subprocess has no task tools or MCP access.

## Interfaces

The MCP tools are `get_judgment_policy`, `list_judgments`, `review_with_tonborg`, `assess_agent_action`, `assess_task_completion`, `get_agent_pins`, and `pin_agent`. Autonomy changes and feedback remain local user operations. Agent entry context supplies the current policy and workflow guidance; existing sessions should reconnect to discover newly installed tools.
