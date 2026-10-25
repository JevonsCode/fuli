# Retrieving Context

Part of the capturing-session-knowledge Skill; read SKILL.md first.

## Retrieve Context

For facts about the current local project, call `search_current_project_knowledge` with the
current working directory. It resolves the exact active project without requiring the Agent to
copy an ID, searches that child project first, and then includes only inheritable knowledge from
authorized parents or shared-source projects. Use `search_knowledge_graph` for personal-global
context, explicitly named extra projects, subscribed public projects, or advanced scoped queries.
An already resolved temporary project is an active private scope for this task. Pass its exact
returned `personalProjectId` alongside the directory; without a directory, use
`search_knowledge_graph` with that exact project and personal space. Do not re-resolve it from
a repository name, and never omit its `personalProjectId` or move its facts to personal-global.
Use `search_connected_knowledge` for a project-bound third-party source or explicitly selected
public project. Keep its source sets separate and obey the project's conflict policy;
`agent_decide` affects only the current response and never mutates or confirms a source.

Search when prior durable context can materially improve the task.
Before saying that a stable fact is unknown or asking the user to provide it again, search
Fuli if it may have been learned earlier. Strong triggers include URLs, deployment routes,
requirements, terminology, architecture, prior decisions, runbooks, rationale, and remembered
personal preferences. Do not search for a fully self-contained task or use Fuli as proof of live
external state.

First inspect `task_knowledge_recall` returned by the lifecycle or preference tool. Its automatic
query plan is deliberately bounded and based on implementation trigger categories, not on a
claim that every returned candidate supports the task. If it misses or its candidates are
irrelevant while durable context may still matter, call `search_current_project_knowledge`
yourself. A coding task without such a trigger may instead get `status: indexed` with a
`knowledge_index`: up to five `[id, title]` pairs of matching items in the exact current project and
their `matched` count, never their bodies. A title is only a pointer: read the item with
`search_current_project_knowledge` (query its title) before relying on it, and cite only what you
read. Derive one to four focused queries from the action, artifact, target system, distinctive
identifier, and likely runbook category. Never pass the full conversational request as the sole
query. For example, a version-release request should search release/publish and push/commit
runbook concepts separately instead of searching the entire sentence.

Its response states `retrievalGuidance`, `noMatchSourceMarker` and the shared scope fields once
at the top level; each entry in `results` keeps its own `query`, records and `sourceMarker`. On a
bounded page (`next_cursor` present), a query with nothing on that page shows only `query` and
`total_items`; its records arrive on a later page. Long project ID lists name a prefix and count
the rest in `project_ids_omitted`.

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
`contextPersonalProjectIds`. Without an active local or resolved temporary project, search only the personal-global
profile. For public context, pass only the active or explicitly named subscribed public project
IDs; never search every personal project, every subscription, or the whole graph by default.
Use the current repository, the user's wording, and `list_knowledge_spaces` to resolve scope.
Ask if the active project remains ambiguous.

FULI exposes read-only MCP resources for this selection flow. When the Agent host offers a FULI
project or the global taste resource in its `@` mention picker and the user selects it, treat the
resource's exact identifiers as explicit scope for the current task. Use the selected
`personal_project_id` for project retrieval, or apply the global taste resource as a
personal-global profile. A selected resource never authorizes searching another project,
following `RELATED_TO`, or performing a write.

The active child project may also retrieve only knowledge explicitly marked inheritable from
projects reached through its outgoing `PART_OF` or `USES_KNOWLEDGE_FROM` relations. This means
project-specific PRDs, configuration IDs, and debugging notes remain in the child, while a parent
may own shared run, validation, and test runbooks. Search the child first, then authorized parents.
Project-scoped personal preferences may enter the child context only when the preference is
explicitly marked `descendants`, or `selected_projects` includes that exact active child, and the
parent is reached through `PART_OF` or `USES_KNOWLEDGE_FROM`. Never inherit `local_only`, never
traverse `RELATED_TO`, stop after two hops, and retain the returned scope path. Confirmation
authority is a hard gate before scope distance; within the same authority layer the nearest scope
wins, while equal-layer conflicting instructions remain deferred and weight cannot choose a winner.

After a retrieved personal item materially affects the final answer or a completed action, call
`record_knowledge_usage` once for that task and item with `cited` or `applied`. Do not record
retrieval, inspection, automatic preference injection, or unused context. Usage evidence can
promote only to `agent_confirmed`; it never substitutes for human confirmation or makes an item
eligible for public publication. Use the current user task's caller-stable identifier as
`taskId` and reuse it on retries; never generate another ID to recount the same task.

## Use the Generated Taste Skill

When a UI, writing, product, architecture, code, or other judgment call would benefit from the
person's established taste, call `get_user_taste_skill` with the current working directory and
current task prompt. It returns a bounded, read-only `user-taste` Skill projection built from
effective personal preferences and task-matched recommendations. Apply the current request and
authoritative constraints first; treat `Confirmed` and `Observed` evidence differently; preserve
project scope; and explain the matching preference and material tradeoff when recommending.

The projection is regenerated from the durable graph as preferences are added or revised, so it
can grow over time without copying or overwriting a user-authored `user-taste/SKILL.md`. Never
promote a pending inference in the generated Skill and never treat the projection itself as new
knowledge to capture.

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
