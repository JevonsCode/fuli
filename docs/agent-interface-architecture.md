# Agent interface architecture

FULI exposes product data operations through structured Agent tools so an AI Agent does not need browser automation to act on the user's behalf. The console and the Agent interface are peer clients of the same application services; neither client owns a second copy of the business rules.

## Contract

`list_agent_interfaces` serves the versioned `agent-interface-parity-v1` catalog. Without arguments it returns an index (under 12 KB): the guidance, coverage and delegation categories, each domain's tool names (`domains`, with `readRouteDomains` for those that also have console read routes), each route group's console changes counted by access in coverage order (`areas`, grouped by the segment after `/api`, each count array in the order `[agent, agent_delegable, agent_delegable_off, agent_relayed, local_user_only]`), the tools of each group's `agent` entries (`areaTools`), and `otherTools`, the tools neither names, so every tool name is in the index. One part comes in full on request (each under 16 KB): `domain` for one read workflow with its guidance and read routes, `area` for one route group's entries, `route` (as listed, or `METHOD /api/...` path, matched the way the console matches a request) for one entry. A name that is not there answers `found: false` with the names that are. Every view is cut from `agentInterfaceCatalog()`, the one full table, which tests and `run_delegated_action` use directly. Every console data mutation is classified as one of:

- `agent`: the catalog names the structured Agent tool or tools that perform the same business operation.
- `local_user_only`: the catalog records why the operation requires local human presence.

The parity catalog is executable product metadata, not just documentation. Tests verify that every `agent` entry names a registered tool and that sensitive local-only routes remain explicit. A route with multiple actions, such as ignoring or resetting routing-learning evidence, lists every matching tool.

## Request path

```text
Console UI ───────┐
                  ├─> application service ─> scoped Provider / local store
Agent tool / MCP ─┘
```

Agent handlers delegate to existing application-service methods. They do not call the console over HTTP, render pages, write browser state, or bypass scope checks. Existing Host/Origin protection remains relevant to the console; Agent access is independently guarded by the Agent-access policy before any tool handler runs.

## Required operating sequence

### Agent names and human attention

Agent identity (`agentId`) and role (`profile.name`, `responsibility`) remain stable.
`profile.displayName` is the editable person-like nickname. Legacy role-style names
receive a deterministic nickname derived from their Agent ID; existing custom names
and explicit display names are preserved. These are product nicknames, not real people.
Reading a legacy profile does not rewrite its stored history.

Every new Agent (Bole's recruitment or a direct write) gets a nickname no other Agent in the
personal space uses: one that reads as a job title ("PPT 专责", "design Agent"), or none at all,
is replaced by a generated name such as "Lyra North", and so is a person-like role name another
Agent already has. When every first-and-last name is taken, generation goes on with a double
surname ("Lyra North-Vale"); a number is the last resort and is not reached before 32,768 names.
A built-in role's own name (Jefa, Bole, Tonborg, Astro) counts as taken. A `displayName` given on
purpose that another Agent already has is refused with `agent_name_taken`, who uses it and in which
projects (`used by: …`, also as fields) and three free generated names, before anything
is written (a recruitment checks its proposed name when the task is submitted; one taken by the
time the Agent is provisioned falls back to a generated name). The job stays in `profile.name`,
the occupation and the responsibility. An update that omits `displayName` keeps the stored one;
changing it to a name another Agent uses is refused the same way.

The person's FLA naming preference (FLA 取名偏好, `agentNamingStyle` in the device settings, edited on
the person's home page beside Bole, local-user-only) is free text, so only a model can follow it: the recruiting Agent reads it with
`get_agent_naming_style` right before it proposes a new Agent's `displayName`, and FULI only
checks that the name is free. It is never added to a task entry. A clash means proposing another
name in the same style; an Agent that cannot find one tells the person. No style means the
generated names above; the field shows that rule as editable starting text, and leaving
or restoring it saves no style. Existing Agents are never renamed
automatically: when an Agent's shown name reads as a job title, reading it returns
`nameSuggestion`, a free nickname the profile page offers as a one-click rename.

Uniqueness is held by the graph, not only by the check before a write (graph/24): every Agent of
the person, FULI's own roles included, stores the identity key of its shown name with its space
(`display_name_space_id`, `display_name_key`) under a uniqueness constraint, so two hires or renames
racing for one name cannot both commit; the loser is named again or refused. A built-in role's
built-in name stays reserved by the check, and so does another Agent's 原名 for 30 days after its
rename (the refusal's `used_by` entry then carries `former_name` and `free_from`). A key an older
FULI left on an Agent it renamed (FULI 22 renames without updating it) is cleared when the Provider
starts and whenever it blocks a write; only the key fields change. A refusal carries `used_by` (name, Agent ID, projects)
and `free_names` as fields beside its sentence. Each project there, as in the list of shared
names, comes as its ID, stored name and `scope_type`, so the console names a temporary project
the way it does everywhere (临时项目 #编号) and the sentence an Agent reads gives its number. A rename keeps
the old name in the Agent's name history (`name_history_json`: name, until, `renamed` or
`duplicate_name`, who kept it and why); records carry `nameHistory` and, for 30 days, `formerName`,
which pages, the FLAs list and the `#FLA` notice show as 「原名 …」 on the turn that names the FLA,
and by which `#FLA` still reaches it. Nothing said or signed under the old name is rewritten.

Spaces from before this rule can hold FLAs that share a name (names derived from the Agent ID,
or a write that raced the check). Upgrading changes none of them and needs no confirmation: the
constraint step is automatic, because every key starts empty. Such an FLA keeps working; a write
that would give it a key another FLA already holds stores none and goes through. The person
settles shared names when they choose, on the FLAs page (「有 N 个名字不止一位 FLA 在用」): the
plan (`GET /api/project-agent-name-fixes`, `keep=<agentId>` to pick another keeper) lists each
shared name, who keeps it, the new name of each other FLA and why; the person may leave renames
out, and one apply (`POST /api/project-agent-name-fixes/apply`, `agent_relayed`: an Agent proposes,
only the person's words apply it) renames the rest through the ordinary rename write, refusing
the whole apply if anything changed since the plan was read. New names avoid every name of the
space (each Agent's, every built-in role's, each recent 原名) and each other; past every generated
name a numbered one is given. An apply keys a keeper only once no other FLA shares its name. In each group the name stays with,
in order: a built-in role; an FLA not dismissed; one that is not a test FLA; one whose name a
person gave (a rename in its history, or a name FULI does not generate); one that works beyond
temporary or conversation projects; the one with more work (tasks it took part in, hiring tasks
left out, plus task entries it worked); the one active more recently; the one hired first. The
plan reads the space once, and sums the work of the FLAs that share names in single queries.
`GET /api/project-agent-name-changes` lists every rename with its 原名 and, for a settled name,
who kept it; the FLAs page announces settled names once (`PUT /api/project-agent-name-changes/seen`,
kept with the space) and keeps the whole list under 改名记录.

Use `request_agent_attention` only for an explicit human action, with the exact space,
project and Agent, optional task ID, request kind, context and `requestedAction`.
The same idempotency key and payload returns the same request, including after closure;
reusing a key with another payload is a conflict. Running, waiting in a queue and
recoverable retries do not create attention requests automatically.

`list_agent_attention` supports project/Agent/status filters and pagination. Counts
cover the whole filtered set. Agents can withdraw obsolete requests with
`cancel_agent_attention`, using `expectedRevision` and a reason. Only the local-user
`POST /api/agent-attention/respond` workflow records a human reply. A reply closes the
attention item but does not itself grant permission, accept a task or run a command.
Agents read resolved replies and continue within the existing authority boundaries.

When the person is in the conversation, an Agent asks there with native choices
(`human_interaction`); the console's 待决策 page is the person's inbox for when they
are away. The console sends a reply as a chosen option and an optional note, and the
Provider stores them as one response. The same reply then goes to the requesting
Agent's roundtable inbox for that project: an `agent_chat` wait of that Agent in that
project returns it at once (the console reports "woken" only after the waiting
session took it); otherwise it appears once as `attention_replies` at the Agent's next
task entry or in `read_agent_messages`. Requests that ask the person to do something
by hand (`permission`, `blocked`) offer a "Done" reply, which means the step was done.
Original context, response, actor and timestamps remain in the private graph.

The console uses one shared attention store and dialog for the sidebar and personnel
views. Failed reads remain visible as errors, not a false empty state. Replies use
revision checks and preserve the user's draft on failure. Public reports never query
or expose this private attention queue.

An Agent should:

1. call `list_agent_interfaces`, then the one `domain`, `area` or `route` the task needs;
2. resolve exact space, project, item and version identifiers with read tools;
3. inspect the selected tool's current schema;
4. read current state before a write;
5. execute the narrowest scoped mutation with available compare-and-swap or idempotency fields;
6. verify through a structured read.

The bundled `operating-fuli` Skill teaches this sequence and is installed by `fuli setup` for supported Agents. Browser automation is permitted only as optional visual verification after a structured operation, never as a data-mutation fallback.

## Bounded context and exact contracts

Task entry through either the hook or `get_collaboration_preferences` returns the same compact
context shape: full active preference instructions, bounded working-memory previews and explicit
instructions to read complete memory before writing. Duplicate evidence wrappers are omitted.
`view_project_agent_task` supports `includeEvents: false` to omit event history while retaining
the derived execution summary and observed worker evidence. Detailed reads remain the default.

Summary limits must not alter executable tool schemas. Employee discovery uses a separate exact
catalog projection with explicit size errors; ordinary summaries retain their configured item
and byte budgets without applying a second fixed 20-item limit during byte reduction.

Knowledge retrieval requires current scope evidence. An old unscoped episode cannot make a
currently project-assigned item globally accessible. Explicit project references, opted-in
inheritance and genuine personal-global knowledge keep their existing scope rules; records
without scope metadata fail closed.

Agent working-memory export (`export_project_agent_memory`, catalog read workflow
`agent-memory`) returns generated Markdown for one scope from a fresh database read. It reuses
the `get_project_agent_memory` authority, including host-injected source clients and the strict
scope validator, takes no output path, writes no export file (existing authorized local
directory snapshots may refresh), and is not offered to remote connectors. Its MCP result
budget (512 KiB) holds the largest valid identity plus one memory layer; a result that would
still be truncated fails explicitly instead of returning a partial file. Memory reads,
checkpoints and task entry report directory status in the public `directorySnapshot` field;
the generic MCP omission of internal `snapshot` keys is unchanged.
The console route `GET /api/project-agents/:agentId/memory/export` uses owner inspection authority.

## Human-only boundaries

The following operations intentionally remain local-user-only:

- enabling or disabling Agent access;
- device-level runtime settings;
- confirming, rejecting or retiring an Agent's workflow (`POST /api/agent-workflows/:workflowId/decision`).

The person's own decisions are `agent_relayed` (rec#80, category `decisions`): completing a
preference conflict, confirming preference visibility, batch confirmation, Jefa acceptance,
attention replies, Tonborg votes and review undo, the 「我」 profile, the first-run guide and
capture onboarding, dismissing finished-migration reminders and showing an app export folder.
The person decides in chat; an FLA passes their exact words as `personWords` to
`run_delegated_action`, which runs the change only when the words are in the prompt that began the calling
task (kept locally by a hook entry until its checkpoint, `entry-prompts/`) or in one of the
person's newest 5 saved messages of the calling session (session records, the task's own reader), or in an
answer given since that prompt in the client's own question card, read from the client's transcript
(Claude Code's `AskUserQuestion`; Codex's `request_user_input` output, or for `request_user_input_async`
the next message the person sends). The
delegation record keeps the words and the message they were found in; judgment feedback and
Jefa revisions also keep `relayedBy` and `personWords`, and a relayed batch confirmation's
confirmer is the person (`user`, labelled with the relaying FLA). Other task updates remain
available through the employee tools.

## Agent workflows and the Agent home (rec#60 D-78)

An Agent's home page (`/agents/:spaceId/:agentId`) opens on its 「工作台 / Workbench」 tab when it
has tasks or workflows; an Agent with neither gets no empty workbench, and a built-in role keeps
its own workbench page. The tab is loaded only when opened, unmounted when left, and never polls.
Its board is a view of the tasks assigned to the Agent (`GET /api/project-agent-tasks?agentId=`)
on the shared task board: one project shows that project's own columns, several projects the
built-in five. Cards open the task; the board stores nothing and moves nothing.

Workflows are the Agent's own repeated work as named, ordered steps, in
`agent-workflows.sqlite` (format 3). The task's bound Agent, read from the current
`taskContextToken`, is the only owner a tool acts for:

- `propose_agent_workflow` proposes a workflow from the Agent's own steps; with `workflowId` it
  proposes a change. (Learned X-then-Y candidates, `list_workflow_candidates`, were removed on
  11-23: their only input was retired on 11-11, so the list stayed empty.) Every proposal is a new version and older versions are kept.
- A project Skill draft (rec#78 step 4) is a proposal from three or more of the Agent's own kept
  experiences (`experienceIds`, checked against the project's current kept items). It must carry a
  `workMap` (inputs, outputs, dependencies, branches, acceptance; at most three questions, which FULI
  puts in the person's 待决策 once per draft). The work map is stored with the version
  (agent-workflows format 2) and read back with it.
- `list_agent_workflows` is the index (name, purpose, step count, `approxTokens`, status, last
  run, and `draftable` topics with three or more kept experiences); `read_agent_workflow` returns the confirmed steps of one active workflow;
  `record_agent_workflow_run` records the outcome of a run the Agent did.

Only the person confirms, rejects or retires a workflow, on the Agent's home page, at the
version the page showed. Nothing is active until confirmed and nothing runs by itself. A task
entry carries only names (Jevons 11-23, `fla_growth`, `src/fla-growth/entry-hint.js`), and only
on the first turn of a conversation: the Agent's confirmed workflows in that project (at most
three, name and the first sentence of the purpose), and a repeat the hourly check found
(`src/fla-growth/tool-suggestions.js`, "the same kind of work" per `step-similarity.js`) with the
person's answer once given, in at most two conversations per answer. A proposal of the same kind
of work deposits the repeat (a rejection gives it back); the person's open 待决策 about it is then
withdrawn, and a person who chose 「只记下这串步骤」 has a new workflow (version 1, never active)
confirmed by that choice only when its steps are the ones they chose, one for one (spacing and
case aside); other steps, or a change of an existing workflow, wait on the Agent's page. State
is `agent_growth_hints` (agent-workflows format 3); an entry never migrates the store. Steps are
never put into an entry; an ordinary entry has no `fla_growth` key. The console shows how often
each confirmed workflow was run and ran through, counted from its runs.

## Work surfaces: one table, pause all, resume (rec#11 D-85)

Every FLA's Agent services, Agent apps, workflows and workbenches (one row per FLA share of a
task sheet) are listed in one table with kind, name, owning FLA, project, state and last change,
filtered by FLA, project, kind, state or text (`GET /api/work-surfaces`, `list_work_surfaces`).
The person (`POST /api/work-surfaces/pauses`, `POST /api/work-surfaces/pauses/:pauseId/resume`,
`latest` for the newest) and Agents (`pause_work_surfaces`, `resume_work_surfaces`) may both pause
and resume; there is no approval step. A pause first records each matching item's on/off state in
`work-surfaces.sqlite` (format 1), then turns off the ones that were on; a resume reopens exactly
those. Each pause and resume is recorded with who, when and each item's result
(`GET /api/work-surfaces/pauses`); nothing there is changed or deleted.

Turning off reuses each owner's own switch: an Agent service is stopped through the services
port (the recorded PID, after its identity check), an Agent app through its runner's stop, and
resumed with the runner's start and run gate. FULI did not start an Agent service, so a resume
reports `restart_required` with its recorded command instead of starting it. Workflows (nothing
runs by itself) and workbenches (stopping a run revokes it; a retry is a new task) have no safe
off switch and are only listed.

These are trust boundaries, not missing interfaces. An Agent may explain where the user can perform the action, but must not substitute direct HTTP, storage, shell, or browser scripting.

## External knowledge

Connector discovery, binding creation, readiness checks, target updates, scoped synchronization, live retrieval, conflict policy and deletion have dedicated tools. Connector secrets are referenced by environment-variable name; tool results and catalog listings must not expose secret values.

Moving a connection between projects updates the binding targets. Deleting and recreating a binding is not the default because it breaks audit continuity and can discard connector state.

Target updates require the Agent's last-read `targetsVersion`. Registry mutations take a cross-process SQLite reservation, so sync/check/delete cannot overwrite a concurrent scope update. Busy or stale writes fail with a controlled conflict and must be re-read, not blindly retried. The legacy HTTP contract still accepts callers without a version for compatibility; current console and Agent clients supply one.

## Adding a feature

When a console feature adds a data mutation:

1. implement the business operation in an application service;
2. have the console route call that service;
3. add or reuse a typed Agent definition and a handler that calls the same service;
4. annotate read/write, destructive and open-world behavior for MCP clients;
5. add the route-to-tool mapping to `src/agent-tools/interface-catalog.js`, or document a narrowly justified `local_user_only` boundary;
6. add contract tests covering dispatch, scope, error behavior and the parity mapping;
7. update the `operating-fuli` workflow reference if the operation needs a non-obvious sequence.

A missing Agent interface must remain visible as a parity defect. Do not silently ship a browser-only write path.
