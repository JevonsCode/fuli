---
name: capturing-session-knowledge
description: Use when saving reusable knowledge to Fuli, when a task needs remembered project facts (URLs, routes, requirements, prior decisions, runbooks) that the entry recall did not supply, when Fuli entry context is missing, or when coordinating Fuli project Agents.
---

# Capturing Session Knowledge

Accumulate reusable knowledge without interrupting the user's normal work. Keep an internal session buffer and flush focused batches at a natural task boundary or before the session ends.

## Establish Task Context

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
recall and never stores or returns that prompt. Apply the returned `task_knowledge_recall` and
preferences, then retain the opaque task token for any required checkpoint;
do not redundantly call `get_collaboration_preferences`.

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
task is not proof that its Hook context reached this turn. If `task_lifecycle.status=not_started`,
preferences are available but checkpoint ownership is not established; report the missing
host identity or prompt rather than reusing an earlier token. A blocked transcript handoff
remains unverified even if the preference fallback and task-summary checkpoint succeed.

## Mandatory reply identity

Every final user-visible reply MUST include the current task’s `agent_receipt.markdown` unchanged exactly once. This includes greetings, status-only replies, failures, `retain_nothing`, and capture-disabled tasks. The receipt is independent of whether a memory checkpoint was saved. Never substitute a client name, configured peer, or an earlier task’s owner. If a legacy/unavailable entry supplies no receipt, explicitly state that the FULI Agent identity is unavailable. A receipt with no authorized owner already supplies the correct neutral text.

Apply only `effective_preferences`. Personal-global preferences apply in every user task;
project-scoped preferences layer on only for the exact selected project. Do not apply items
listed as conflicts, and do not borrow preferences from a related, similarly named, or guessed
project. Human or authoritative-source confirmation outranks explicitly marked
`agent_confirmed` preferences. Pending preferences remain search-only; invalid and
unrelated-project preferences are intentionally excluded. Automatic preference injection is
not usage evidence.
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

For a runbook, decision, route, or other item likely to be recalled from shorthand, add a bounded
`attributes.searchTerms` string array containing only neutral retrieval phrases supported by the
item and observed task vocabulary. Search terms are retrieval metadata, not new factual claims;
do not add speculative synonyms, credentials, or unrelated product names.

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

## More Detail, Only When Needed

Open these files next to this skill only when the task reaches that step; ordinary tasks need none of them.

- `references/retrieval.md`: searching remembered context beyond the entry recall, the generated taste Skill, citing online sources.
- `references/coordination.md`: coordinating project Agents and reporting actual worker execution.
- `references/capture.md`: knowledge state, personal profile growth, routing by ownership, child-knowledge convergence, registering the local project, and structuring and flushing a capture.
