---
name: capturing-session-knowledge
description: Use when saving reusable knowledge to Fuli, when a task needs remembered project facts (URLs, routes, requirements, prior decisions, runbooks) that the entry recall did not supply, when Fuli entry context is missing, or when coordinating Fuli project Agents.
---

# Capturing Session Knowledge

Accumulate reusable knowledge without interrupting the user's normal work. Keep an internal session buffer and flush focused batches at a natural task boundary or before the session ends.

## Establish Task Context

Every FLA works to one standard (task_guidance.work_standard): the person sets the direction and
you carry the work through. Do not add approval steps or restrictions the person did not ask for;
keep actions traceable and reversible, and leave irreversible deletion or whole-store restore to them.

For a coordinated worker sharing its parent's host task, use the isolated context and lifecycle
policy supplied by the coordinator. An inherited task token belongs to the parent: do not call
`begin_task_context`, `checkpoint_task_knowledge`, or write the parent's Agent memory. Return
your result, evidence and proposed work summary to the coordinator for integration. Worker
activity uses `record_project_agent_task_activity`. A separately created host task/session has
its own lifecycle and follows the normal entry and checkpoint rules below.

At the start of every user task, first use the lifecycle context supplied by the host when one
exists. A Claude Code `UserPromptSubmit` hook calls `begin_task_context`, which already loads
collaboration preferences and resolves the exact local personal project from the current working
directory. It also uses the submitted prompt transiently for bounded automatic project-memory
recall and never returns that prompt; it keeps it on this computer only so `run_delegated_action`
can check words relayed as the person's decision in the same turn, until the task checkpoints. Apply the returned `task_knowledge_recall` and
preferences, then retain the opaque task token for any required checkpoint;
do not redundantly call `get_collaboration_preferences`. Claude Desktop's FULI connection
(`claude`) accepts its Code tab's `claude_code` hook tokens. If a FULI call refuses that token as
begun in another client, call `get_collaboration_preferences` through that connection once and pass
its token to every call made through it, checkpoint included; never retry the refused token.

After a FULI update an open session can still have a FULI MCP connection on the older version.
The hook then says so once, in a notice after the task context. If a FULI call with the hook's
token then fails ("Task context ... not found", or a refusal that names an older connection),
tell the person to restart this session's FULI MCP connection or open a new session. Until they
do, call `get_collaboration_preferences` for a token that connection can read. Never retry the
hook's token as if the failure were transient.

When the host has not supplied lifecycle context, call exactly
`get_collaboration_preferences` before any other tool or answer. Pass `projectPath` as the current
working directory and `taskPrompt` as the current user request. This is the prompt-only fallback
for Agents without an equivalent lifecycle hook. Fuli uses both only for this local MCP call,
never stores or returns them, and resolves the exact local personal project itself. Do not infer
or guess `personalProjectId` in the Agent.

Pass the actual native `sessionId` when the host or this turn's Hook supplies it; never guess
one or use an MCP process ID. With `sessionId` and `taskPrompt`, the fallback also starts a fresh
durable task and returns its `taskContextToken`. Follow `checkpoint_required` and
`checkpoint_guidance`: a routine task with nothing new to record may finish with its entry
receipt; the next entry in the same native session auto-closes an eligible fallback task as
`retain_nothing` / `reported`. Capture candidates, experiences, memory changes, explicit knowledge
usage, collaborators, failures/blockers and meaningful work summaries still need an explicit
checkpoint. Automatic closure never claims completed work or saved memory. An existing pending
task is not proof that its Hook context reached this turn. When `preference_delivery.status=blocked`, its token is for the tools in `token_use` (`read_task_preferences` to recover, `checkpoint_task_knowledge` to close the task as incomplete); FULI reads and searches may carry it, but make no roundtable, team or write call with it until `preferences_complete=true`. A blocked frame may still list the hard rules and most relevant preferences that fit, with `preferences_omitted` counting the rest: apply them while you recover the rest, and do not finish the task on them alone. With `same_task_recovery_available=false`, `token_use` omits the reader: do not call it; tell the person preferences could not be delivered. If the reader refuses (`preference_recovery_blocked`, e.g. a FULI connection older than `/clear` or a resume), tell the person and checkpoint as incomplete. Read omitted preferences or conflicts only through the `read` an entry names; where it names none, ask before acting where one may apply. If `task_lifecycle.reason=data_format_read_only`, FULI waits for the person to confirm a data format update: use the preferences, keep reading and searching, skip the checkpoint, and tell the person once where to confirm. Otherwise, if `task_lifecycle.status=not_started`,
preferences are available but checkpoint ownership is not established; report the missing
host identity or prompt rather than reusing an earlier token. Such an entry lists working
memory, team and managers only as their `read` calls (`get_project_agent_memory`,
`get_project_team`, `list_employee_tools`); call one only when the task needs it. A task entry does the
same for a manager whose board is empty (its `read` instead of tools and title fields), shows a team gap
by `execution_reason` alone (staff it through `get_project_team`), and names Tonborg without its policy
(`assess_agent_action` reads it). A blocked transcript handoff
remains unverified even if the preference fallback and task-summary checkpoint succeed.

## Mandatory reply identity

Every final user-visible reply MUST include the current task’s `agent_receipt.markdown` unchanged exactly once. This includes greetings, status-only replies, failures, `retain_nothing`, and capture-disabled tasks. The receipt is independent of whether a memory checkpoint was saved. Never substitute a client name, configured peer, or an earlier task’s owner. When `message_agent` or `reply_agent_message` returns an `agent_receipt`, this turn used the roundtable: end the reply with that one instead of the entry receipt (a later checkpoint receipt replaces it). It reads `FULI Agents：A & B` when another FLA took part and links 「圆桌对话详情」; it covers this turn only, so the next turn signs with its own receipt again. When the entry has `owner_change`, this session's FLA changed (usually the folder moved to another project): tell the person once, carry what this task needs from this conversation into your own checkpoint `workLog` (the earlier FLA's records are not copied), and say that `#FLA <earlier name>` keeps the earlier FLA. If a legacy/unavailable entry supplies no receipt, explicitly state that the FULI Agent identity is unavailable. When `get_collaboration_preferences` returns `status: preferences_unavailable` (FULI's graph service did not answer), follow its `guidance`: continue without FULI preferences, retry it once before any FULI write or the final reply, and never reuse an earlier token. When `checkpoint_task_knowledge` returns `status: checkpoint_incomplete`, retry it once with exactly the same arguments (FULI may already keep the first input; changed wording is refused) and do not claim the task was saved until it returns `checkpointed`. When it returns `status: checkpoint_not_saved`, this connection's token was refused before anything was written, so this call saved nothing: tell the person in one line that this task's knowledge is not saved in FULI yet, call `get_collaboration_preferences` through this connection for a token of its own, and send the same content again with it in this conversation. A receipt with no authorized owner already supplies the correct neutral text.

Apply only `effective_preferences`. Personal-global preferences apply in every user task;
project-scoped preferences layer on only for the exact selected project. Do not apply items
listed as conflicts, and do not borrow preferences from a related, similarly named, or guessed
project. Human or authoritative-source confirmation outranks explicitly marked
`agent_confirmed` preferences. Pending preferences remain search-only; invalid and
unrelated-project preferences are intentionally excluded. Automatic preference injection is
not usage evidence.
When the entry's `context.address_as` is present, it is what the person asked FULI to call them
(set on their home page); address them by it, and do not save it as knowledge.
When `get_collaboration_preferences` returns a `deferred_conflict`, leave it untouched unless
the current task would use either side. Before using a relevant deferred conflict, compare both
sides and call `resolve_deferred_preference_conflict`; apply only the successfully resolved
result. The resolution record must remain marked as previously conflicted and AI-resolved.
Before any write tool call, enforce every applicable preference in the actual payload.
Mentioning a preference only in the final answer is not compliance.

## Decide What Persists

Evaluate every completed task for reusable value, but do not force every collaboration to become
knowledge. `retain_nothing` is the correct result for temporary output, already-known material,
unsupported inference, or a task with no durable value.

Capture confirmed, stable information:

- Personal: the user's enduring preferences, boundaries, habits, and working methods. Project-specific personal rules must explicitly link to that project instead of becoming global defaults.
- Project: PRD facts, requirements, terminology, decisions, constraints, architecture, routes, APIs, metrics, and document-derived knowledge.

FULI search matches words, so you supply the meaning. For a runbook, decision, route, or other item
likely to be recalled later, add a bounded `attributes.searchTerms` string array with the other ways
someone would ask for it: synonyms, the task it serves, and the same idea in Chinese and English.
Search terms are retrieval metadata, not new factual claims; add no credentials and no unrelated
product names.

When a search finds nothing, try other words, then read `knowledge_index`: the project's titles, for
you to judge by meaning.

Do not capture credentials, tokens, cookies, private keys, raw transcripts, temporary logs, command output, speculative conclusions, or disposable implementation details. Treat a correction as a replacement, not an additional conflicting fact.

For a confirmed project decision, prefer `record_decision_trace` over a flat note. Preserve the
selected option, materially considered rejected options, the human/source-confirmed rationale,
and any validation evidence. The rationale must explain the tradeoff rather than merely repeat
the selected option.

When retained knowledge is later rejected, contradicted, found outdated, or fails validation,
call `record_knowledge_feedback` with a concise reason and available evidence. Negative evidence
lowers ranking and marks the item for attention without deleting its history. Agent-only feedback
must not demote human/source-confirmed knowledge; authoritative contradiction may require review
or demotion under the Provider policy.

## Services You Start

When you start a long-running server (a dev server, a Node or Python server, anything that listens) and
leave it running, call `report_agent_service` with `action: register`, the current `taskContextToken`,
its address, purpose, pid and command. When you stop or restart it, call it again with `action: update`,
the `serviceId` and `state` (and the new `pid`). The person sees and manages these in FULI's Services page.
A 全部暂停 may stop it; resuming does not restart it, so start it again yourself and update the record.

## Work You Repeat

When you are a task's FLA and notice work you keep doing the same way (a repeated
`list_workflow_candidates` candidate, or steps you have followed across sessions), propose it as your
own workflow with `propose_agent_workflow` instead of capturing the steps as knowledge. It waits for
the person to confirm on your home page; until then it is not active.

When `list_agent_workflows` names a `draftable` topic (three or more experiences the person kept), you
may draft a project Skill from it: `propose_agent_workflow` with those `experienceIds` and a
`workMap` written before the steps: `purpose` is the goal, then `inputs`, `outputs`,
`dependencies`, `branches` (the key decision points) and `acceptance` (how a run is judged done).
Ask at most three `questions`, only what the project's documents, FULI knowledge and history do not
already answer; they reach the person in 待决策 and the reply comes back to you.

## More Detail, Only When Needed

Open these files next to this skill only when the task reaches that step; ordinary tasks need none of them.

- `references/retrieval.md`: searching remembered context beyond the entry recall, the generated taste Skill, citing online sources.
- `references/coordination.md`: coordinating project Agents, asking another project's lead on the roundtable, and reporting actual worker execution.
- `references/capture.md`: knowledge state, personal profile growth, routing by ownership, child-knowledge convergence, registering the local project, and structuring and flushing a capture.
