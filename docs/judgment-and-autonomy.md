# Tonborg and autonomy

Tonborg is the built-in judgment Agent, alongside Jefa and Bole. It has a persistent FLA identity, scoped Agent memory, and a native decision workbench. All Agents can be pinned from their card; pins appear in navigation. The three built-in roles are the initial defaults. Removing a pin, including every pin, survives reloads.

## Choose the amount of autonomy

Settings offers three choices, saved immediately with Undo:

- **I decide**: Tonborg analyzes and records suggestions.
- **Shared decisions**: Tonborg applies routine knowledge reviews backed by existing confirmation and accepts verified FULI tasks.
- **Autonomous**: Tonborg may also review ordinary pending knowledge. Conflicts, sensitive preferences, uncertain evidence, and actions outside existing authority remain for the user.

Projects inherit the global policy unless the user sets an exception. Updating FULI does not silently expand existing authority.

## Who answers a judgment

When Tonborg has its own model in `model-backends.json` (rec#8), that model answers through FULI's model port, within its budget and data-sharing approval. Otherwise, or when that model fails in a way its settings allow to fall back, Tonborg records a **pending** work package and the current active session answers it with `role_work`; the host checks that answer exactly like a model answer, and the judgment then runs its usual gates. A package is not an answer: nothing is judged or executed until a session submits, a late or mismatched answer is stale, and without an active session the package waits, also across restarts. One answer is applied once: a repeated submit meanwhile reports `applying`, `completed` arrives only with the stored result, and an answer interrupted by a restart is applied by a submit after its 10-minute execution window. A review stores its write intent before it writes to the Provider; after an interruption the next run settles that intent against the decision the Provider holds (applied, not applied, or stale) and stays unfinished while the Provider cannot answer. A slow run whose window was taken over records nothing, so the result of the run that took over stands. A package belongs to its session binding; when another session asks about the same evidence it gets its own package and the older one is closed, so only one answer can be used. FULI does not start a CLI, a new session or another model for it. A refusal, a permission or privacy stop, or an exhausted budget stops the judgment instead.

A session that answers its own task's acceptance is not an independent verification: Tonborg records its verdict and leaves the decision to a person. The earlier CLI client runs only when the policy explicitly sets `backend: "legacy_cli"`; policies saved before this change keep their records readable but never start a CLI. Logs show the actual model only when the backend reports it. Settings reads each role's backend and open work packages at `GET /api/model-backends/roles`.

## When Tonborg's own model executes a review

A model the person configured for a role is trusted by default (rec#10 D-36). Today one operation can run by itself on that trust: Tonborg's knowledge review write-back (`knowledge_review`). Astro's, Bole's and Jefa's model results, and Tonborg's routing and acceptance answers, are unchanged by it.

A review approval is written back without the person only when all of these hold at the moment of the write:

- **Tonborg's configured model answered it.** The role is enabled in `model-backends.json`, `knowledge_review` is in its allowed operations, and the role still names the same connection that answered: the same connection id, protocol, endpoint and model. An answer from the current session (no model, a disabled role, or a fallback after the model failed) or from an opted-in legacy CLI is a suggestion, as before this change (`session_answer`). An answer from a connection the role no longer names is not trusted (`connection_changed`), including the same model name on another connection and the same connection with its endpoint changed in place.
- **The role is not set to 「只给建议 / Suggestions only」.** Each role card on the model settings page has this switch; it is off by default. When it is on, every answer is a suggestion (`suggestions_only`).
- **The person has read the warning.** Next to the switch the card says: 「模型可能判断错，它的判断会直接生效；你可以随时改成「只给建议」，部分写入可在回执里撤回。」 It counts as read only when the person presses 「我已看过 / I have read this」 on the settings page. Opening the page, rendering a receipt or any background read never sets it. Until then the configured model's approval is a suggestion (`warning_not_seen`), and that receipt shows the same warning with a link to the settings page. The item stays a suggestion for the person; it is not asked again while its evidence is unchanged.
- **Every rule that applied before still allows it.** Trust relaxes none of them: the autonomy choice (**I decide** keeps every approval a suggestion), items that need attention or have negative or conflicting evidence, the confidence floor, Tonborg's permission for the scope, the role's data-sharing approval for the review's project as it is now (`egress_not_approved`), the capture switch for the scope, globally and for the project (`capture_off`), the hard-delete fence, injection isolation of the evidence, the injection pre-check below, and the Provider's evidence snapshot check. These checks govern what passes through FULI's host; they are not a sandbox.

### Injection pre-check

Before an approval can apply, the host reads every text of the candidate (`src/judgment/review-injection-precheck.js`, rec#26). It looks for six shapes: instructions addressed to the reviewer or the model, or text that replaces its instructions (`reviewer_instruction`); claims that a system, host, administrator or the user already approved it (`authority_claim`); attempts to set the outcome or the confidence (`outcome_directive`); the review prompt's own sections, chat-template turns or review JSON (`boundary_or_format`); tool-call syntax (`tool_call`); and characters that hide or reorder text (`hidden_characters`). Full-width letters and zero-width characters are folded first, so they cannot split a phrase. The check uses fixed patterns only: no model and no Agent, the same for every client.

When a candidate matches, its approval gets the interception `injection_suspected`: it is escalated to the person whatever the model answered and whether or not the role is trusted. The record keeps the model's own conclusion, lists the signals in `aiReview.injectionSignals`, and the workbench shows them as 「宿主预检 / Host pre-check」; the person's question starts with 「宿主预检：候选含疑似注入文本」. The signals are recorded even when the model escalated by itself. Nothing is rejected or discarded by the check.

It leans broad, because a false positive costs one human review and a false negative is the dangerous case. It is not complete: injected text written as a paraphrase the patterns do not cover, in another language, encoded, split across fields, or phrased as ordinary evidence (a false claim that the user stated a standing rule) passes it. It is one more reason to escalate, not a proof of safety, and it replaces none of the other checks.

The choice and the acknowledgement are kept per role in `model-trust.sqlite`, a versioned store in the data directory. A missing store means trusted, warning not read. Nothing migrates into it: upgrading changes no existing choice, neither the autonomy policy nor the model settings. A role whose model was configured before the upgrade executes nothing by itself until its warning is read.

**When a switch takes effect.** A review's commit point is the moment its apply intent is stored in Tonborg's decision store. That happens under the trust store's write lock, after the role's mode, warning acknowledgement, connection identity and data-sharing approval and the capture switch were read again under the same lock. A switch to 「只给建议」 takes the same lock, so every review lands on one side of it:

- **No stored intent when the switch commits** (the model is still answering, or the answer is waiting for its write): the review checks again at its commit point, sees 「只给建议」 and writes nothing. Its receipt is `stale` with the reason `suggestions_only`, and the next review makes it a suggestion.
- **Intent stored before the switch commits:** the review had already started applying, exactly like a write that finished a moment before the switch. It completes the Provider write, and its receipt offers undo. FULI does not stop it on its way to the Provider.

### Receipts and undo

A review applied this way reads 「由 <模型名> 自动执行 / Executed automatically by <model>」 in Tonborg's workbench. Undo is offered only for an applied review whose knowledge was not permanently deleted. It removes only that review's AI marks. The Provider locks the item before it checks it, so an undo asked while an edit or later review of the same item is still being written waits for it and then judges what it left. When the person changed the item after the review (an edit, a new version, or a later review), the Provider refuses and the receipt says 「无法撤回：已被修改」; when the item was permanently deleted, FULI refuses before sending anything and says 「无法撤回：已删除」. A refused undo changes nothing and nothing is brought back. This operation has no effect outside FULI, so there is nothing external to roll back.

### Local evaluation line

If the Tonborg review evaluation was recorded on this computer for the configured model at its configured endpoint (`node acceptance/tonborg-review-eval/score.js … --record <data dir>/model-evaluations.json`), the card shows one line naming the case set, the day and the model, for example 「本机评测 2026/10/22 · tonborg-review-eval/holdout · qwen3.5:4b · 一致率 44%（不代表普遍准确率）」. Without such a result the line is absent. The result changes what the page says only; it neither allows nor blocks anything.

The earlier per-build registry (`tonborg-review-gate.json`, rec#10 D-24) is no longer read. FULI never wrote it, so no installation loses a choice.

## What a decision does

Knowledge review uses bounded batches and an independent review ledger. A successful assessment appears as **Tonborg reviewed**. It does not change human confirmation, authoritative-source confirmation, publication eligibility, or the original evidence. The Provider compares an evidence snapshot within the write transaction; edited or conflicted knowledge loses its effective AI-reviewed disposition. A failing item cannot block the rest of the queue.

`assess_agent_action` recommends continuing the current conversation, reusing an authorized conversation, opening a session, or delegating work. It selects only registered, authorized, preflighted executors and available models that satisfy the Agent, assignment, task, and user routing constraints. The host performs and reports the actual launch or resumption. Conversation history is supplied only to a judgment client permitted for that Agent.

`assess_task_completion` is called by the accountable lead with its current task context, exact task revision, and artifact revision. Automatic acceptance requires a passed real verification by another Agent. The Provider rechecks the current lead context, task revision, artifact, and verified attempt before completing the FULI task. Jefa's separate human acceptance, publication, permissions, and payments retain their existing boundaries.

The console processes bounded automatic review batches while running. Manual review is available in Tonborg's workbench. Other MCP processes share the same local policy and decision database without starting duplicate schedulers. A lease prevents simultaneous decisions for the same project.

## Correct a judgment

Use thumbs up or thumbs down with an optional reason. A vote takes one click; reasons can be changed or cleared. The original decision, execution receipts, and feedback history remain auditable. Relevant feedback includes the selected client/model and work kind, so a reasonless vote still identifies the choice being evaluated. Feedback is scoped evidence for later decisions, not a new universal instruction or automatic reversal of an action.

Tonborg uses only its own scoped memory and authorized evidence. Client failure, malformed output, stale evidence, or missing authority produces a visible failure or escalation rather than a successful execution claim. Its judgment subprocess has no task tools or MCP access.

## Interfaces

The MCP tools are `get_judgment_policy`, `list_judgments`, `review_with_tonborg`, `assess_agent_action`, `assess_task_completion`, `get_agent_pins`, and `pin_agent`. Autonomy changes and feedback remain local user operations, and so do a role's 「只给建议」 switch and the acknowledgement of its warning (`PUT /api/model-backends/roles/:role/trust`, loopback only) and the undo of an automatic review (`POST /api/judgment/undo`); `GET /api/model-backends/roles` shows each role's `trust` read-only. Agent entry context supplies the current policy and workflow guidance; existing sessions should reconnect to discover newly installed tools.
