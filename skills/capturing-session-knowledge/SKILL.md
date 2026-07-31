---
name: capturing-session-knowledge
description: Use when Fuli tools are available and a task may depend on remembered personal preferences or durable project facts such as URLs, routes, requirements, architecture, prior decisions, runbooks, or rationale, or when ordinary work produces reusable knowledge worth retaining.
---

# Capturing Session Knowledge

Accumulate reusable knowledge without interrupting the user's normal work. Keep an internal session buffer and flush focused batches at a natural task boundary or before the session ends.

## Establish Task Context

At the start of every user task, first use the lifecycle context supplied by the host when one
exists. A Claude Code `UserPromptSubmit` hook calls `begin_task_context`, which already loads
collaboration preferences and resolves the exact local personal project from the current working
directory. Apply that returned context and retain its opaque task token for the final checkpoint;
do not redundantly call `get_collaboration_preferences`.

When the host has not supplied lifecycle context, call exactly
`get_collaboration_preferences` before any other tool or answer. Pass `projectPath` as the current
working directory. This is the prompt-only fallback for Agents without an equivalent lifecycle
hook. Fuli uses the path only for this local MCP call, never stores or returns it, and resolves the
exact local personal project itself. Do not infer or guess `personalProjectId` in the Agent.

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

## Retrieve Context

For facts about the current local project, call `search_current_project_knowledge` with the
current working directory. It resolves the exact active project without requiring the Agent to
copy an ID, searches that child project first, and then includes only inheritable knowledge from
authorized parents or shared-source projects. Use `search_knowledge_graph` for personal-global
context, explicitly named extra projects, subscribed public projects, or advanced scoped queries.

Search when prior durable context can materially improve the task.
Before saying that a stable fact is unknown or asking the user to provide it again, search
Fuli if it may have been learned earlier. Strong triggers include URLs, deployment routes,
requirements, terminology, architecture, prior decisions, runbooks, rationale, and remembered
personal preferences. Do not search for a fully self-contained task or use Fuli as proof of live
external state.

Pending knowledge is eligible for on-demand retrieval and must remain visibly marked.
`agent_confirmed` knowledge is usable but ranks below user or authoritative-source
confirmation.

Treat an obvious content-location request specially: examples include asking for a named page,
URL, route, deployment, document, file, or where a durable artifact is located.

1. Run one bounded search that preserves distinctive names, identifiers, and quoted phrases from
   the user's wording. Do not dilute them with generic expansion. An unrelated result is no
   evidence even if the tool labels it matched.
2. If there is no supporting result, ask whether to widen this one read-only lookup to all
   registered local personal projects and, if still unresolved, the current repository or
   workspace files. Explain that it applies only to this lookup, excludes public projects and
   paths outside the current workspace, then stop and wait for the user's answer.
3. Only after explicit confirmation, call `search_knowledge_graph` again with
   `personalProjectScope: all_local_confirmed`. Never infer consent from the lookup intent itself.
4. This expanded scope does not expand any public project or subscription and must not become a
   persistent default. If it still has no supporting result, continue with a local file fallback:
   - When the current directory is inside one repository, search only that repository.
   - When it is an intentional multi-repository workspace root, search only that workspace.
   - When it is the user home, filesystem root, or otherwise too broad or ambiguous, ask for an
     exact safe repository/workspace root and stop. Never recursively scan a home or system root.
   - Within the safe root, use read-only `Grep`/`Glob`/`Read` or `rg`. Preserve the exact quoted
     name first, respect ignore rules, and inspect only relevant matches and routing/deployment
     context. Do not inspect credential stores, browser data, secrets, or paths outside the root.
   - A route string alone is not a live URL. Require deployment-domain or equivalent evidence.
     If local files still provide no supporting evidence, ask for a project, document, or source
     clue.

Personal retrieval always includes the bounded personal-global profile. For a local personal
project, pass its exact `personalProjectId`; if the user explicitly names another personal
project, resolve it with `list_personal_projects` and add only that exact ID through
`contextPersonalProjectIds`. Without an active local project, search only the personal-global
profile. For public context, pass only the active or explicitly named subscribed public project
IDs; never search every personal project, every subscription, or the whole graph by default.
Use the current repository, the user's wording, and `list_knowledge_spaces` to resolve scope.
Ask if the active project remains ambiguous.

The active child project may also retrieve only knowledge explicitly marked inheritable from
projects reached through its outgoing `PART_OF` or `USES_KNOWLEDGE_FROM` relations. This means
project-specific PRDs, configuration IDs, and debugging notes remain in the child, while a parent
may own shared run, validation, and test runbooks. Search the child first, then authorized parents.
Never inherit project-scoped personal preferences, never traverse `RELATED_TO`, stop after two
hops, and retain the returned scope path. Exact active-project knowledge with the same stable key
overrides an inherited item.

After a retrieved personal item materially affects the final answer or a completed action, call
`record_knowledge_usage` once for that task and item with `cited` or `applied`. Do not record
retrieval, inspection, automatic preference injection, or unused context. Usage evidence can
promote only to `agent_confirmed`; it never substitutes for human confirmation or makes an item
eligible for public publication. Use the current user task's caller-stable identifier as
`taskId` and reuse it on retries; never generate another ID to recount the same task.

The current `agent-usage-v1` policy requires at least five idempotent material-use events across
at least three distinct tasks in the current content generation, with no open knowledge or
preference conflict. It maintains utility and confidence as separate scores and caps
Agent-confirmed confidence below human/source confirmation. Agents report qualifying use; they
do not calculate, override, or claim the promotion themselves.

For “why was this code written?” questions, use stored evidence relationships and a separately configured Git MCP together. Never invent a commit, PRD link, or missing history. For “what errors happened today?” questions, obtain current data from a monitoring/log MCP; use Fuli only for runbooks, architecture, prior causes, and other durable context.

## Preserve Online Sources For Knowledge Refresh

When the user provides an online project or document link and the current Agent has a connector
or tool that can read it:

1. Read the current source with the Agent's available capability. Fuli does not implement or
   pretend to provide source-specific reading.
2. Distill only durable knowledge, then pass the exact stable original HTTP(S) link as
   `sourceUri` to `capture_session_knowledge`. Do not substitute a temporary download URL,
   fabricate a link, or put credentials in the URI.
3. Route confidential or internal sources to personal knowledge with `private` or `restricted`
   sensitivity. The runtime may retain the source URI; never copy a real internal URI into Git
   project files, fixtures, examples, logs, or public project evidence.
4. When the user later asks to refresh the knowledge, search the relevant scope, use the returned
   `source_uris` from supporting facts or entities, re-read the source with the current Agent,
   and revise or supersede the corresponding Fuli knowledge while preserving history.

This workflow refreshes knowledge stored in Fuli. It does not imply or require writing back to
the original online document. If the current Agent cannot read the source, report that limitation
and never invent source-derived knowledge.

Every `search_knowledge_graph` response provides two terminal-safe Markdown choices:
`sourceMarker` for returned items that support the answer, and `noMatchSourceMarker`
for a search with no supporting result. A tool-labelled match that is irrelevant to
the answer still requires `noMatchSourceMarker`.

For the chosen marker, the final answer must begin with its `leadMarkdown` unchanged,
before any heading or prose, and append its `markdown` unchanged after the answer. If
any search supports the answer, choose `sourceMarker` from one supporting search. If
none do, choose `noMatchSourceMarker`. Never show either marker when no search was
called. For a no-match search, `noMatchSourceMarker.markdown` is intentionally empty:
show only its `leadMarkdown` and do not synthesize a footer. Never fabricate, rewrite,
omit, or wrap markers in HTML. A capture or write result is not a read citation.

## Decide What Persists

Evaluate every completed task for reusable value, but do not force every collaboration to become
knowledge. `retain_nothing` is the correct result for temporary output, already-known material,
unsupported inference, or a task with no durable value.

Capture confirmed, stable information:

- Personal: the user's enduring preferences, boundaries, habits, and working methods. Project-specific personal rules must explicitly link to that project instead of becoming global defaults.
- Project: PRD facts, requirements, terminology, decisions, constraints, architecture, routes, APIs, metrics, and document-derived knowledge.

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

## Classify Knowledge State

Every entity and relationship needs an `originQuadrant`, `confirmationBasis`, and
`confirmationStatus`. These fields answer three separate questions:

1. `originQuadrant` records how the item was discovered. It is not a truth score and does
   not change merely because the item is later confirmed.
2. `confirmationBasis` explains why the item exists, why it belongs to that quadrant,
   who proposed it, and—when confirmed—who confirmed it and when.
3. `confirmationStatus` is `pending`, `agent_confirmed`, or `confirmed`.

Keep the canonical quadrant names:

- `known_known`: knowledge or a conclusion that was explicitly expressed when captured.
- `known_unknown`: an unresolved question or tradeoff that was explicitly recognized.
- `unknown_known`: tacit knowledge inferred from behaviour, examples, prototypes, or
  reactions.
- `unknown_unknown`: a potential blind spot surfaced during open exploration. A truly
  unknown item cannot be stored; this label describes how the recorded candidate arose.

Every `confirmationBasis` must contain:

- `existenceReason`: why this item was created;
- `quadrantReason`: why it was assigned to this quadrant;
- `proposedBy`: `{ kind, label }`, where kind is `user`, `agent`,
  `authoritative_source`, or `import`;
- `confirmedBy` and `confirmedAt` together when confirmed.

An Agent may propose and explain knowledge. A user or authoritative source creates
`confirmed`; a deterministic Fuli usage policy may create only `agent_confirmed`, with an Agent
confirmer, timestamp, and policy version. Agent confirmation is lower-authority, never
public-eligible, and must not be produced by retrieval alone. Confirmation covers the content
and its classification. If either changes, return the item to `pending` and start a new usage
generation unless the same revision explicitly records a new valid human/source confirmer and
confirmation time. Legacy items without that audit record are `pending`, even if an old
`epistemicStatus` said `confirmed`.

`currentQuadrant` and `epistemicStatus` are legacy compatibility fields. Do not use them
for new product logic and do not treat them as confirmation evidence.

Agent retrieval includes pending items on demand and returns their status so the caller can
calibrate claims. Only user or authoritative-source `confirmed` project knowledge may enter
public review, regardless of how it was originally discovered; normal personal preview and
Maintainer review gates still apply.

## Grow The Personal Profile Separately

Durable facts about the person's collaboration style use `profileAspect`. They default to
the personal-global graph without `personalProjectId`:

- `taste`: aesthetic, writing, product, architecture, or engineering outcomes the user
  likes or rejects.
- `personality`: stable self-described collaboration or working traits. Agent-inferred
  personality stays `pending` and must never be silently promoted to confirmed.
- `judgment_preference`: repeated decision criteria, tradeoff priorities, risk posture,
  and conditions that change how the user chooses.

When the user explicitly limits one preference to a project, keep `profileAspect` and capture
it with that exact `personalProjectId`; this makes the preference project-scoped without
turning it into public project knowledge. Use `set_personal_preference_scope` when the user
later changes the scope. Never put any personal-profile item into a public proposal.
For a preference that may have both global and project-specific forms, store a stable
`attributes.preferenceKey` on each form so the project value can explicitly override the same
global decision without hiding unrelated preferences.

## Route by Ownership

- Route global personal knowledge to `targetKind: personal` without `personalProjectId`; it is written directly to the local personal graph.
- Route knowledge for a local personal project, including an explicitly project-scoped personal preference, to `targetKind: personal` with that project's exact `personalProjectId`. This is private local knowledge, not a public submission.
- Route knowledge to `targetKind: project` only when the target is an explicitly selected subscribed public project. It becomes a team-shared Provider Proposal and must remain pending until a Maintainer reviews it.
- Never treat a project as public merely because the current repository or conversation has a project name. Only an active subscription makes it eligible for public project routing.
- Never omit `personalProjectId` when the current repository or conversation has already resolved one local personal project; doing so would leak project-specific facts into the personal-global scope.
- Never add another personal project to `contextPersonalProjectIds` merely because it is related, similarly named, or referenced by the active project. Automatic borrowing is limited to item-level inheritable knowledge reached through `PART_OF` or `USES_KNOWLEDGE_FROM`; all other cross-project borrowing requires an explicit user request or selection and applies only to the current search context.
- Never route project facts through the personal graph to bypass review.
- Never auto-approve a project Proposal.
- If ownership is genuinely ambiguous and changes who can see the knowledge, ask one concise question instead of guessing.

## Converge Shared Child Knowledge

When multiple direct children of one parent independently contain substantially equivalent
runbooks, conventions, or architecture facts, call `discover_common_knowledge_candidates`.
Discovery is read-only and must compare child-local knowledge with inheritance disabled so a
parent item cannot manufacture its own promotion candidate.

Never promote automatically. Preview a candidate with
`preview_common_knowledge_promotion`, show the proposed parent ownership, descendants inheritance
mode, selected duplicates, and scope rationale, then require a human confirmation reason. Apply
with `apply_common_knowledge_promotion` only using the one-time intent-bound preview token. The
Provider must atomically create or move the canonical parent item, mark descendants inheritance,
supersede child duplicates, and record the promotion audit. Child-specific exceptions stay in
their child projects.

## Resolve Or Create The Local Project

Before the first project-scoped capture in a repository:

1. Call `list_knowledge_spaces`, then `list_personal_projects` for the active personal space.
2. Resolve the repository root from the current working directory and repo-local manifests. Use a stable, human-readable project ID derived from the repository or manifest name. Never store an absolute path, local username, hostname, credential, or private remote URL as the project ID or public profile evidence.
3. Match an existing personal project by exact project ID, publication mapping, or confirmed repository identity. Do not merge projects from similar names.
4. When one previously unseen repository has an unambiguous identity, immediately create a minimal private personal project with `upsert_personal_project`. Use lifecycle `active`, a private repository source with no URI, and an evidence-coverage summary containing only facts visible in the current repository. Do not generate a generic list of information the project supposedly lacks.
5. Ask one project-identity question only when the working directory contains multiple plausible projects or the repository identity conflicts with an existing project.

Creating a personal project is local classification, not public publication. Never create or subscribe to a public project automatically.

## Structure and Flush

Use `capture_session_knowledge` with a small, coherent batch:

1. List spaces when the target IDs are not already known.
2. Summarize the durable facts; do not submit the entire source document or conversation.
3. Create stable entity keys, typed entities, and explicit uppercase relationships. When relevant, model `GitCommit`, `CodeSymbol`, `PRDSection`, `Runbook`, and `Incident` entities and connect them with relationships such as `IMPLEMENTED_IN`, `DEFINED_BY`, `MOTIVATED_BY`, `APPLIES_TO`, and `INVESTIGATED_WITH`.
4. Include source kind, source application, a non-sensitive source description, reference time, session ID, and a retry-safe idempotency key. When an online source was actually read, also include its exact stable `sourceUri`. When available, include a stable source turn ID and only the smallest relevant excerpt needed to understand the evidence; never include a full transcript.
5. Use `supersedes` when replacing a known relationship and set confidence below `1` only when the source itself expresses uncertainty.
6. Flush silently at the boundary. Continue the user's task without narrating routine capture.

If `capture_session_knowledge` or automatic project creation returns `capture_disabled`, the
user has disabled automatic capture. Do not retry, do not create a fallback record elsewhere,
and do not describe the skipped batch as stored. Existing knowledge may still be queried.

Before sending the final response, perform one checkpoint. For a hook-managed task, call
`checkpoint_task_knowledge` exactly once with either `capture_candidates` and the bounded durable
batch, or `retain_nothing`. For a prompt-only Agent, either flush the durable batch directly or
determine that the turn produced no reusable knowledge. Do not finish a reusable project decision
with an unflushed batch.

Only notify the user when capture fails, conflicts with existing knowledge, or requires an ownership decision. If project knowledge was proposed successfully, do not interrupt merely to announce the pending review item.
