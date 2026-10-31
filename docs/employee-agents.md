# Specialist Agents

An employee template is a reusable role with an optional FULI-hosted or native workbench. Recruitment reuses the existing durable Project Agent identity and assignment model. Four roles are fixed: **Jefa**, the project manager and project-attribution triager, **Bole**, the AR (Agent Resources) Agent, **Tonborg**, the judgment Agent, and **Assistant** (`employee.assistant`), the unassigned-conversation receptionist. They exist in every personal space from the start and are never offered for hire; Jefa, Bole, and Tonborg span all projects by default while Assistant belongs to no project and receives conversations that do not yet match a formal project. They require no separate runtime package. See [judgment and autonomy](judgment-and-autonomy.md) for Tonborg's review, feedback, and execution-choice workflow.

Every Project Agent requires a primary occupation (`occupation.role`, from `product`, `engineering`, `design`, `operations`, `testing`, `research`, `data`, `writing`, `management`, `lead`, or `assistant`) plus up to five optional secondary tags. Bole writes the primary occupation at recruitment with an audit trail, and the user can change it at any time as final authority. Each formal project has one project **lead** (`lead`) who breaks down work, dispatches tasks by occupation (`new_session → sub_agent → phased`), integrates results, and signs off to the user without performing specialist implementation work directly. When a project needs a given occupation, Bole reuses an existing same-occupation Agent across projects before recruiting a new specialist.

## User flow

Every Agent the console shows is built in, so the console has no hiring step. To narrow what Jefa, Bole or Tonborg manage, use **Manage assigned projects** on their card or workbench. For Bole and Tonborg, whose identities the Provider provisions, the save only edits the projects of the existing active identity (with the same version check, assignment reasons and read-back); it never creates or reactivates one (`system_managed_employee`). The Assistant works globally and takes no projects. A custom employee package is recruited through the `recruit_employee` Agent tool only. The custom project picker supports multiple selection, individual exclusions, search, and **Invert selection**. **All projects** includes future active projects unless explicitly excluded. **Selected projects** keeps a fixed selection; selecting none in that mode leaves the role without a project. The Agent directory reflects the persistent identity; **Specialist Agents → Jefa** in the sidebar opens its built-in board directly. Hiring alone does not create a project. Register a lasting project from the personal-project directory, or explicitly coordinate a one-off task to use the temporary scope described below.

Specialist workspaces use a compact host toolbar rather than the generic console heading. They keep the workspace's own navigation and content, plus the host's project switcher and responsibility editor. The selected project is reflected in the URL; an unauthorized explicit deep link is never silently redirected to a different project. Empty assignments, unavailable templates and catalog errors each have an actionable state. The `employee` CLI/API/manifest names are unchanged for compatibility.

If a page was open across a build update and its lazy-loaded files are no longer available, the console retains the current page and offers **Reload and open** for the intended destination. It does not automatically discard the current page or enter a reload loop. Application HTML is revalidated and missing assets are not cached.

**All projects is a standing policy; Selected projects is a snapshot.** An upgrade preserves the selection of existing employees until the user explicitly enables the new policy. Archived projects are unavailable. For an existing employee, use **Manage assigned projects** in its details or workbench; the older assignment action routes to the same editor. Removing a project ends its assignment with temporal history and excludes it from all-project management; it does not delete the employee, project, board, or tasks. Existing archived-project history and unavailable exclusion IDs are preserved.

The directory's **Filter projects** control supports multi-selection and inversion but only changes which Agents are shown. Its unrestricted view includes unassigned Agents; employee project views use effective responsibility, not ended history. Filtering never changes permissions or preselects additional projects in the editor. The editor retains its last-read baseline even if another consumer refreshes the catalog. The workbench's **Currently viewing** selector switches one isolated board; its separate management action edits responsibility. Future-project policy coverage does not fabricate Provider assignment history.

Repeat recruitment is idempotent. Customized profile preferences and executor/model policies are preserved. One employee identity can have multiple project assignments. Reactivating an inactive identity is an explicit action; a conflicting unrelated identity is never overwritten. Recruitment does not start an executor or constitute model usage.

The catalog shows whether a workbench is ready: built in (Jefa), installed, or not installed. Identity-only templates need no runtime and remain valid employees without a sidebar workbench. A trusted built-in template may declare `workbench: { "kind": "native", "view": "people" }`; Bole uses this native panel to summarize Agent distribution, current tasks, and timestamped recruitment reasons from the same Project Agent APIs used elsewhere in the console.

## Unassigned conversations, Jefa triage, and explicit temporary tasks

Normal task-entry conversations that do not match a registered repository or an explicit project name at the start of the prompt no longer auto-create `conversation-<hash>` projects or auto-recruit per-conversation leads. Instead, they are received by the fixed **Assistant** (`employee.assistant`) in global scope with only personal global preferences, and their content stays in the conversation log without polluting any Agent's long-term memory. At session completion, **Jefa** records deterministic attribution triage (`existing_project`, `new_topic`, or `one_off`) without invoking an extra model; once a `new_topic` accumulates 3 conversations over at least 2 days, it grows into a formal project with an editable AI-drafted summary, Bole assigns a project `lead`, and the topic's conversations are attached to it (rec#11 D-86). The runtime setting `topicPromotion` decides how: `auto` (default) forms it at once and the checkpoint returns `triage.promotion.notice`, which the Agent appends to its reply unchanged; its link opens Astro's page on that project to rename or move it, or undo it (the conversations are unassigned again, a project Astro created is archived, and the topic grows again only after 3 more conversations). `ask` only proposes it (`triage.proposal`) for the person to accept in the console.

When the Assistant has its own model in `model-backends.json` (rec#8, operation `project_candidate`), a task entry that every deterministic rule left as `pending_assignment` also asks that model, once per host session, which project the opening of the task (at most 600 characters) seems to belong to. The candidates are only the projects approved for the Assistant's model, plus `none`; each one's name and description is sent as evidence of its own project, and the prompt itself needs `allowUnassigned`. With no approved project nothing is sent. The answer is the entry's `project_candidate`: a hint such as 「可能属于「X」，需你确认」, with 「（候选仅限已批外发的项目）」 when some projects were not candidates, and the gate `suggestion_only`. It binds nothing: the person confirms through the usual triage label or correction, and a person's label always wins. Before anything is shown, the original request is checked again against the Assistant's current data-sharing approval (the prompt and every candidate), and the conversation's label and the task's project are read again; a withdrawn approval, a person's label or any newer attribution made while the model ran replaces the hint with `superseded`. That only limits what is shown: it cannot recall what was legitimately sent. The whole decision has a 3-second deadline, retries included. `none` shows nothing; a timeout or other failure the settings allow to fall back keeps its reason and receipt and leaves labelling to the session as before; a refusal or exhausted budget keeps its reason. Either way the session's one hint is used up. Without the Assistant's model the entry is unchanged.

Explicit `coordinate_project_agent_task` calls can still create a task-scoped temporary project when
project resolution is `unmatched` or `not_provided`. Preference reads remain read-only; an
ambiguous or invalid explicit project is never replaced with a temporary one. Use the exact
returned project ID for subsequent task operations. Temporary projects do not participate in
automatic directory matching and do not inherit another project's private context.

The scope is marked `type: temporary`, `lifetime: task`, `persisted: true`: its audit history
is retained after the task, rather than deleted. Agent staffing defaults to temporary and still
follows recruitment confirmation, allowed-client and executor policies. A request may therefore
be `awaiting_recruitment` or blocked before execution. Fuli returns a worker plan; the authorized
host starts and reports actual workers. Creating the scope or assigning an Agent does not create
an execution-summary row.

The Agent directory's first-task prompt is usable without registering a project. Task details
show scope, assignment, worker evidence and why a completion summary is unavailable. Registration
remains useful for work that should share a stable project identity across future tasks.

## Local installation

Jefa's board needs no installation: its runtime ships with FULI (see [Jefa's built-in board](#jefas-built-in-board)). Installation is only for a custom employee package someone built. The console never asks the person to run a command; a custom package that is not installed is shown as an identity without a workspace.

```sh
fl employee install <built-package-directory>
fl employee install <built-package-directory> --replace
```

An optional `--runtime-config <file>` selects a specific existing FULI runtime. The command only installs the local directory supplied by the operator. It does not download a package, execute an install script, change Agent client settings or start another server.

Packages live under the configured FULI data directory, separately from employee board data. Changed packages require `--replace`; upgrades keep a backup and never overwrite board data. Content identity is verified from the files, not merely from the installation receipt. A loaded runtime changes after FULI restarts.

Only a regular `.installation.json` at the package root is excluded from content identity as host-generated metadata. File-type validation still rejects receipt symlinks before installation can write through them. Files with that name in subdirectories remain package content: changes require an explicit replacement, and directory contents still undergo normal validation.

**Installed runtimes are trusted JavaScript running with the host's privileges, not sandboxed plugins.** Only install trusted packages. Path confinement, manifest validation, size limits, rejection of symlinks, `.env`, `.git` and `node_modules` protect the installation boundary; they do not make malicious runtime code safe. Manifest permissions and FULI's permission, egress, injection and hard-delete checks constrain only what a runtime asks of the FULI host; they do not stop trusted code from reading files, using the network or starting processes itself. [Agent apps](agent-apps.md) run on the same trusted footing in this version.

## Manifest API v1

```json
{
  "schemaVersion": 1,
  "id": "release-reviewer",
  "version": "1.0.0",
  "name": "Release reviewer",
  "role": "Release reviewer",
  "description": "Reviews a project's release checklist.",
  "occupationEmoji": "🔎",
  "capabilities": ["Release review"],
  "workKinds": ["release_review"],
  "initialPreferences": ["Read the checklist before proposing changes."],
  "permissions": ["release.read"],
  "runtime": null
}
```

For a workbench, replace `runtime: null` with:

```json
{ "apiVersion": 1, "entry": "runtime/index.mjs", "webRoot": "web" }
```

The runtime exports `createEmployeeRuntime({ dataDirectory, packageDirectory, manifest })`, returning:

| Method | Contract |
| --- | --- |
| `describeTools()` | Tool names, descriptions, required manifest permission and JSON input schemas |
| `callTool(name, arguments, context)` | Validate arguments and execute inside the supplied space/project |
| `handleHttp(request, response, context)` | Serve the workbench without creating a listener |
| `close()` | Release database handles and other owned resources |

Context includes `personalSpaceId`, `project`, `agentId`, and `basePath`; HTTP adds `origin` and `relativePath`. Runtime code must not substitute a caller-supplied project for trusted context. A tool can be called only if its permission is declared by the manifest. New public catalog metadata is not an authorization grant to execute shell commands or use external credentials.

Optional manifest fields `defaultProjectScope: "all" | "selected"` and `taskEntry: { "boardTool": "read_board", "titleTool": "prepare_session_title" }` declare defaults and task-entry participation without a template-specific host branch. Context also carries the trusted `management` policy and native `session` identity when available. Task-entry board tools must declare `board.read`; the host returns bounded data and guidance, not an automatically started worker. A failed employee runtime degrades manager context without breaking collaboration preferences.

The optional built-in-only native workbench declaration is `workbench: { "kind": "native", "view": "people" }`. It renders host-owned read models and does not load third-party code. Installable employee packages continue to use the runtime contract above.

The reserved identity is `employee.<template-id>`, recognized by the generic `fuli.employee:<template-id>` capability. Preserve this marker when customizing employee profiles. The actual role, history, memory and project assignments remain in FULI's existing Agent model.

`employee.bole` is additionally reserved as the only system AR identity. Its Provider type is `hr`; other identities cannot claim that type. Recruitment history records the coordinating and AR Agent IDs, time, reason, proposed identity and final recruited identity, which powers Bole's people panel without inventing activity.

### Dismissal

Bole also handles an Agent leaving ("dismissal"). The user starts it or approves it; Bole never picks whom to dismiss. In a client session, ask Bole to dismiss an Agent and it first asks why: `dismiss_project_agent` refuses a missing or placeholder reason. Project leads (hand off first), Agents with open tasks and the fixed roles are refused as before. A dismissal archives the identity, ends its assignments and stores, in the same write, the reason, up to three short lessons and a Markdown handoff of the Agent's working memory. Tasks, recruitment and routing history stay readable, the employee number stays with the archived identity and is never reused, and the profile shows why the Agent left.

Lessons are not loaded into anyone's context. Task entry and a pending recruitment only report how many lessons exist for the same occupation or project and the `list_agent_dismissal_lessons` query to read them; `get_agent_handoff` returns the stored handoff. Setting `archived` through a profile update is rejected; only test-marked roles can still be archived directly, for test cleanup. A dismissal button for Bole's own model on the management page is not available yet.

## HTTP and MCP

The host serves `/api/employee-templates`, recruitment/workspace/tool endpoints below it, and `/employee-workspaces/<template-id>/<project-id>/…`. Existing Host/Origin, JSON-body and LAN authorization checks apply. All workbench requests require an active matching identity and authorized responsibility policy, including assets and Agent discovery. Selected mode additionally requires an active assignment; all mode includes future active projects but enforces explicit exclusions and ended assignments before reaching the runtime.

The existing FULI MCP exposes `list_employee_templates`, `recruit_employee`, `list_employee_tools`, and `call_employee_tool`. Workbench operations resolve an exact registered project from its path or an authorized explicit project ID; unresolved or mismatched projects fail closed. Clients need to rediscover tools after upgrading the FULI installation they launch. Editing a source checkout does not update an already installed server or active MCP session.

Employee tool discovery preserves complete JSON Schema contracts, including deeply nested
fields and enums. Use `includeSchemas: false` for a compact list, then `toolName` to read one
complete contract. The catalog has a 64 KiB response limit; an oversized catalog returns a
controlled error with this recovery sequence instead of a partially usable schema. Only tools
allowed by the installed employee manifest are returned.

Discovery and invocation accept either `projectPath` or an already resolved `personalProjectId`.
When directory resolution is unavailable, pass the known ID and omit the path. If both are
provided, the path must resolve to that same project. The selected project must exist, be
active and be assigned to the employee under the current management policy; an explicit ID
does not bypass these checks. This supports remote directories and arbitrary checkout names
without inventing a second project or guessing from its description.

Recruitment accepts an exact `projectPath` (MCP), a legacy `personalProjectId`/`personalProjectIds` selection, or a `management` policy; legacy project selectors cannot be mixed with a policy. Policy shape: `{ mode, projectIds, excludedProjectIds, titleMode, titleStyle }`. `all` stores exclusions and no inclusion list; `selected` stores a fixed project list and no exclusions. Omission for a new identity uses the template default; explicit empty selection recruits without an assignment. Arrays are deduplicated and bounded to 500 entries, and validated before writes. Existing policy replacement requires `replaceAssignments: true` plus the last-read `expectedAssignmentsVersion`. A stale selection fails with `assignment_scope_conflict`; an identical retry is idempotent. Changes preserve customized preferences, role, and executor policies.

Management policy is stored beside the employee data in SQLite with cross-process compare-and-swap protection. It is saved before Provider changes so excluded access fails closed even after a partial failure. Assignment changes are individually durable, not one Provider transaction; removals precede additions. If a batch fails, `assignment_update_incomplete` requires reloading actual state before retrying. Receipts include the new version, policy, counts, and records. MCP results remain bounded and may report `truncated`; never treat truncated assignment records as a complete scope. Workbench, task entry, A2A and tool-call gates enforce the current policy on every request.

Jefa supplies nine workbench tools for board/task reading, task creation, optimistic-concurrency updates, a project's own board, status questions, and session-title preparation/receipts; [Jefa's built-in board](#jefas-built-in-board) lists them. Title settings allow automatic actions, suggestions, or off. Native rename execution belongs to the current client: the employee must not claim success before an actual client receipt, overwrite a manually locked title, or edit client databases/transcripts. Clients lacking native rename capability retain suggestions.

When Jefa has its own model in `model-backends.json` (rec#8, operation `board_match`) and the task's project is approved for it, a task entry that the host has already authorized for Jefa and whose board it read also asks that model, once per host session, which listed board task (at most eight, the same window as the entry) the opening of the task (at most 600 characters) continues, or `none`. The model runs in FULI's host, never in Jefa's workbench runtime. The prompt and each task's title, summary and status are evidence of the task's project; options are positional and host-written. A task without a project, Jefa without access, or an empty board sends nothing, and the Assistant's `project_candidate` and Jefa's `board_match` never run for the same entry. The answer is the Jefa manager's `suggested_match`: a hint such as 「可能是看板上的「X」任务」 with the gate `suggestion_only`. It writes nothing and grants nothing: creating, updating or linking a task still goes through `call_employee_tool` with its permission, human-acceptance and version checks. Before it is shown, the original request is checked again against Jefa's current data-sharing approval, the board is read again through the same gates, and the task's project is read again; a withdrawn permission, a chosen task that changed, moved or was deleted, or a task now in another project replaces the hint with `superseded` and its reason. The whole decision has a 3-second deadline, retries included. `none` shows nothing; an allowed fallback keeps its reason and receipt and leaves matching to the session as before; a refusal or exhausted budget keeps its reason. Either way the session's one board hint is used up. Without Jefa's model the entry is unchanged.

## Jefa's built-in board

Jefa's board runtime ships with FULI in `src/employees/builtin/jefa/`, so Jefa is `ready` in every installation with no install step. It implements the same Manifest API v1 as an installed package, and the package registry loads it the same way. If a Jefa package was installed under `employees/packages/jefa`, that package replaces the built-in runtime; a damaged one does not, and the built-in board keeps working.

The board is one SQLite store, `employees/data/jefa/board.sqlite`, opened through the shared data-format module and listed with the other local stores, so `fuli migrate status` and backups see it. It is separate from `employees/data/management.sqlite`. Every row is keyed by personal space and project, and the runtime only uses the project FULI authorized. Each task keeps its current state, and every change also appends the state it produced, with who made it (`agent` or `person`), to an immutable revision table. Tasks are never deleted.

The nine tools, each limited by the permission it declares:

| Tool | Permission | Contract |
| --- | --- | --- |
| `read_board` | `board.read` | Tasks ordered by status (active, blocked, review, planned, done), priority and recency. `limit` 1–200 (default 50), optional `statuses`. `version` changes on every board write; `truncated` says more tasks exist. `projectBoard` is the project's own board (below). |
| `get_task` | `board.read` | One task with acceptance criteria, tags and its last 20 revisions. |
| `create_tasks` | `board.write` | Up to 20 tasks. `messageId` makes a retry return the same tasks; the same ID with other content is `request_conflict`. New tasks are private and start `planned` unless a status other than `done` is given. |
| `update_tasks` | `board.write` | Up to 50 updates, each with the `expectedUpdatedAt` it read. One stale update refuses the whole request with `version_conflict` and nothing is written. `requestId` makes a retry return the first answer. `done` is never accepted. |
| `configure_project_board` | `board.write` | On the person's request only: `managerAgentId` (the project's own project manager, or `null` for Jefa itself) and/or `board`. `requestId` makes a retry return the first answer; `expectedRevision` refuses a stale edit with `version_conflict`. |
| `answer_status_question` | `board.read` | Counts per status, tasks waiting for the person's acceptance (`review`), blocked tasks and the named tasks, from the board alone. |
| `prepare_session_title` | `session.title` | A title from only the session's linked tasks. `execution` is `client_required` (auto mode and `canRename`: the action the current client performs natively), `suggestion`, `unchanged`, `locked` (the title is locked or the person changed it after Jefa's last applied one) or `off`. A verified caller can prepare only its own session. |
| `report_session_title` | `session.title` | The client's receipt: `applied` with the observed title, `failed` or `declined`, for one ready proposal at its revision. |
| `get_session_title` | `session.title` | The current title record of one session in the project. |

Workspace routes under `/employee-workspaces/jefa/<project>/`:

| Route | Who | Answer |
| --- | --- | --- |
| `GET /` | anyone the host lets in | Redirects to the console board, `/employees/jefa?project=<project>`. |
| `GET .well-known/agent-card.json` | same | Name, description, version and capabilities; Jefa is reached through `call_employee_tool`, there is no separate A2A endpoint. |
| `GET api/snapshot` | same | `{ snapshot: { projects: [sharing state], workItems } }`: the whole private board of this project. |
| `PATCH api/work-items/<task>/status` | the person, on this computer | `{ status, boardColumn? }`; `done` records the person's acceptance time. `boardColumn` is one of the project's own columns and must stand for `status`. |
| `POST api/work-items` | the person, on this computer | A task the person creates; only here can a task be marked `visibility: "public_summary"`. |
| `PATCH api/projects/<project>/sharing` | the person, on this computer | `{ publicShareEnabled, acceptsPublicRequests: false }`. Enabling keeps an existing slug; disabling drops it, so the old link answers 404. The path's project must be this workspace's project. |
| `GET api/public/<slug>` | anyone the host lets in | `{ project: { id, name }, items, acceptsRequests: false }`: only tasks marked `public_summary`, and only their ID, title, status and priority. |

The three person-only routes answer 403 `local_user_only` from another device, like the other local decisions in the interface catalog. No route adds a login or another access barrier.

### A project's own project manager and board

Jefa is the global lead of every project and its own flow does not change: five built-in statuses, and only the person accepts `done`. A project can still get its own project manager and its own board (Notion 「更好的项目管理」):

- **Project manager.** One of the project's Agents, usually a durable Agent with occupation `management` (管理), named in the board's `managerAgentId`. The host checks it is active and holds an active assignment in that exact project; Jefa, Bole, Tonborg and AR are peers and are refused. `null` means Jefa manages the project directly. If the Agent's assignment ends later, the board keeps the name and the project page says the manager is no longer in the project.
- **Built-in board with the person's columns.** `board: { kind: "builtin", columns: [{ id, label, mapsTo }] }`, at most 12, in order. Each column stands for one built-in status (`mapsTo`), and several may stand for the same one (发布到测试环境 and 上线 both `active`). A task moved to a column keeps its `boardColumn`; a status change alone leaves it in the first column for its new status. A column keeps its `id` across renames and reorders. A column standing for `done` is the person's acceptance: an Agent is refused with `human_acceptance_required`. No columns means the built-in board.
- **External board.** `board: { kind: "external", external: { url, label? } }`, an `http(s)` link without credentials. FULI does not manage its tasks; Jefa's board shows the project as a link card.

The record lives in Jefa's board store (`jefa_project_boards`, with every revision in the immutable `jefa_project_board_revisions`), keyed by personal space and project like the tasks, and `read_board` returns it as `projectBoard` (revision 0 is the untouched built-in board). It is set three ways, all through `configure_project_board` and the same host check: the project page's 「项目看板」 section, Jefa's tool in a conversation, or `create_project_agent_assignment` with `projectManager: { board? }`, which assigns the Agent and then makes it the project's manager. That call checks the board before it writes anything; if the board write fails after the assignment, it answers `project_board_not_saved` and a retry with the same `idempotencyKey` finishes it.

The console board shows the project's own columns when the filter shows that project alone; with several projects it keeps the built-in columns and labels each card with its project's column name. A project with an external board shows its link card instead of tasks.

## Verification and release boundary

Jefa uses one native `EmployeeTaskBoard` for every project scope. `/employees/jefa` and
`?project=all` show the current managed projects; legacy `__all__` is normalized. A single
project query or repeated `project` query parameters filter the same board, without changing
assignments. Task details and creation use the existing `get_task`, `create_tasks`, and
version-checked `update_tasks` interfaces. Explicit human confirmation of `done` continues
through the existing human HTTP endpoint. Other employee packages retain their generic iframe
workspaces; Jefa no longer switches to the package board when a card is opened.

The external-report action beside Jefa's identity has an independent project selection,
including all, one, several, and inverted selection. Generating a link explicitly enables
sharing for selected projects through `PATCH /employee-workspaces/jefa/<project>/api/projects/<project>/sharing`
with `{ publicShareEnabled: true, acceptsPublicRequests: false }`. Merely opening or filtering
the dialog performs no writes. Sharing status comes from the existing scoped snapshot API;
disabling uses the same endpoint with both flags false and invalidates that project's old slug.

One `/reports/jefa` link aggregates the selected project capabilities in its URL fragment,
keeping them out of HTTP access logs and referrer query strings. The report loads only
`GET /employee-workspaces/jefa/<project>/api/public/<slug>` and uses the same board in read-only
mode. It never loads the console shell or private board/task endpoints. The existing public
projection controls visibility: private tasks, details, evidence, and unrelated projects are
not included. Partial enablement is reported without claiming a complete link, and selection
changes clear the previously generated link. “All” is the current selection, not consent to
publish future projects automatically.

Before presenting a report link, the dialog verifies the selected public projections and
shows their task count. A zero-task selection is not presented as a successful report;
existing empty links explain that no tasks have been approved for public viewing. This
never changes task privacy or substitutes private board data for a public projection.
Refreshing the preview preserves the selected projects.

These structured HTTP operations remain subject to the host's existing scope, Origin and LAN
authentication checks. The link is not a separate authorization layer for the entire console.
Loopback links work only on the same computer; this UI does not enable LAN access, tunnels,
production hosting, or new public task visibility. Do not expose the local management service
as a public multi-user report server.

Run FULI's normal Node/web tests and typecheck. For Jefa's built-in board, or a Jefa package someone built:

```sh
node scripts/employee-package-smoke.js
node scripts/employee-package-smoke.js --serve
node scripts/employee-package-smoke.js <built-package-directory>
```

The smoke fixture uses a synthetic FULI directory but the real Jefa runtime (built in, or the installed package when a directory is given), SQLite and MCP transport. The UI mode does not query a personal provider or external model. It deletes its temporary test data on shutdown.

Signing, remote catalog distribution, a runtime sandbox, database migration/uninstall UX, and production multi-user authorization remain separate release work. This feature does not authorize or publish a Feishu application.

### Bole identity upgrades

Local startup calls the idempotent system-AR endpoint for both fresh and existing installs.
It consolidates the reserved legacy `fuli-project-hr` identity into `employee.bole` in one
transaction. Names never identify merge targets. The legacy node remains an audit alias;
assignments, recruitment references, attention and task history follow the canonical Bole.
Old profile links resolve to Bole, and the obsolete ID cannot be recreated as another role.
Working-memory heads and immutable checkpoint JSON/hashes are retained; equivalent old/new-ID
memory retries address the same checkpoint. Knowledge visibility metadata is migrated only
inside the owning space, without changing historical evidence UUIDs.

Conflicting memory heads, locked executor policies, relationship properties or overlapping
learning buckets abort the complete migration. Nothing is silently selected or overwritten.
The Neo4j acceptance tests require an explicitly disposable loopback database; they never
clear or seed an existing user's graph.

### Bole's score card

Bole keeps a score card for every Agent from facts FULI already records; the card itself calls no model and has no switch. The executor-learning buckets supply completion (the latest completed or failed run of each task), first pass (completed with no rework request and no earlier failed run) and user feedback (praise, negative feedback, ratings of 4–5 or 1–2). Completion and first pass count each task once across every executor, so a task that failed on one executor and was finished on another is completed but not a first pass. Test and user-acceptance results and Tonborg's acceptance verdicts supply review. A Tonborg verdict counts only when Tonborg judged another Agent's passed verification for a task this Agent worked on, and only while that artifact and verification are still the task's current ones. A verdict on a superseded artifact or verification is shown as stale, and one the user thumbed down as disputed; neither counts either way.

The dimensions are shown separately with their sample and never combined into a total. Below three samples a dimension says 数据不足 and draws no conclusion, so unreported or idle work never counts against an Agent. The S/A/B/C tier is only a display label shown with its evidence count; nothing acts on it. When an Agent does poorly on one executor and well on another, a tool flag suggests changing the model or client rather than the Agent; this per-executor view is a separate diagnosis and never changes the Agent's dimensions. The card carries counts only; `get_agent_score_card` with a `dimension` (and optionally `executorId`) returns the task IDs behind it, newest first. The local API serves the same reads at `GET /api/project-agents/:agentId/score-card` and `…/score-card/evidence`. Ignoring or resetting learning evidence changes the card the same way it changes routing.

With `review: true`, a card for one project also carries Bole's suggested next step: `observe`, `coach`, `switch_model`, `reassign` or `dismissal_interview`. When Bole has its own model in `model-backends.json` (rec#8, operation `performance_review`), that model picks one of these host-listed actions from the card's dimensions, within its budget and data-sharing approval for that project; it gets no tools and can name no task, project or Agent. A dimension with 数据不足 never counts against the Agent, and any action other than `observe` must cite a scored dimension, or the answer is rejected as `invalid_output`. The result is a suggestion for the person only, with the gate `suggestion_only`: it writes nothing, and a reassignment or dismissal still goes through its own tools and confirmations. Without Bole's model the card comes back unchanged and the current session judges it as before, with no work package. A card across several projects, or one where every dimension lacks data, is not sent to a model. Every model result keeps its reason and a compact model receipt. Only a failure Bole's settings allow to fall back (`fallbackToSession`) hands the review to the current session; a refusal, unapproved data sharing, an exhausted budget or a failure without fallback suggests nothing and says what would let Bole review again (approve the project, raise the budget, enable fallback). FULI never starts a CLI, a session or another model for it.

Every result Bole's `performance_review`, the Assistant's `project_candidate` and Jefa's `board_match` returned after asking their own model (suggested, superseded, stopped or handed back to the session) is also recorded, as the session received it then but without the session guidance, in `role-suggestions.sqlite`, and only while recording is on for that call: the capture decision for the task's (or, for Bole, this client's and the project's) scope is read after the model answered, and anything that cannot be read records nothing. Turning recording off never changes what the role returns. Settings → 模型与用量 lists them under 「建议记录」, together with the knowledge reviews Tonborg left to the person (docs/judgment-and-autonomy.md, 「Suggestions in the console」), with the model, the time each was made, the readable evidence (Bole's cited dimensions) and, for a stop or a supersession, the reason in plain words. These are records of what was said at the time, never a to-do: a suggestion followed by a newer one for the same Agent or conversation reads 「已有更新」, and whether anything is still to do is answered by the page each action opens (the Assistant's unclaimed conversations, the task on Jefa's board, Bole's score card read-only), which says when it cannot tell. Nothing there applies a suggestion or treats it as permission. The console reads them at `GET /api/model-backends/suggestions`, like its other full reads: loopback only, a LAN device with its LAN code included, and only after the console server confirmed its own human-review proof (rec#11 D-60, docs/judgment-and-autonomy.md, 「Console trust boundary」); no Agent tool reads them. The server attaches that proof itself, so a local process can still read the list over loopback HTTP; FULI is a local tool and has no console login (rec#11 D-70). The list shows the last 90 days; rows older than that or beyond the newest 300 are deleted when the next record is written, not on expiry, and a plain delete is not an erasure of the disk. A record names Agents, conversations, projects and board tasks, never a knowledge item, so FULI cannot tell which model reason quoted knowledge a person permanently deletes. A permanent delete therefore clears the words of every record of that space written up to the delete's own recorded time (the hint, the model's reason and uncertainty, and the project and task names it showed), keeping only its time, role, status and target IDs; the section shows such a record as 「内容已因彻底删除清除」. Every later cleanup run of the same delete (a retry, recovery at console start, an old link's status page) uses that same time, so it never reaches a record written after the delete. A new record is stored without words while a delete in the space is still open, and also when a delete was open or began after its role read its evidence, since the model may have answered from knowledge that is gone since. FULI has no personal-project or conversation deletion today (projects are archived), so no such deletion clears these records yet.

Each role's row under Settings → 模型与用量 also has a collapsed 「变更记录 / Change history」: every change saved from the console to the role's effective model settings (each changed field, before and after, for the role and the connection it names; a role sharing a saved connection gets its own entry marked as changed through the other role's settings) and to its 「只给建议」 switch or warning acknowledgement, newest first with its time (rec#11 D-42). A key reference is shown only as replaced, never by its value; keys never reach the record. The rows are kept in `model-settings-history.sqlite`, cannot be edited or deleted and are never pruned; Agents read them at `GET /api/model-backends/history?role=&limit=`. A save that changes nothing records nothing. If a change cannot be recorded it still stays saved, and the save answers `history: "not_recorded"`. Without naming a cause, the list notes 「这里有修改没有记录下来」 where a record does not start from what the one before it left, and 「当前设置与最后一条记录不一致」 on top when `model-backends.json` or a role's execution mode is newer than the latest record; a role whose settings existed before the first recorded save, or whose execution mode changed before recording began, ends with 「更早的改动没有记录」.
