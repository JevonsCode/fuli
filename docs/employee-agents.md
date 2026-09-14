# Specialist Agents

An employee template is a reusable role with an optional FULI-hosted or native workbench. Recruitment reuses the existing durable Project Agent identity and assignment model. The built-in specialists are **Jefa**, the project manager, and **Bole**, the fixed system HR Agent. Bole is created with every personal space, cannot be archived or replaced by another `hr` identity, and does not require a separate runtime package.

## User flow

Open **Project Agents → Hire an Agent**, select a template and its responsibility policy, then hire. The custom project picker supports multiple selection, individual exclusions, search, and **Invert selection**. A newly recruited Jefa defaults to **All projects**, including future active projects unless explicitly excluded. **Selected projects** keeps a fixed selection; selecting none in that mode hires without a project. The Agent directory reflects the persistent identity; **Specialist Agents → Jefa** in the sidebar opens its installed board directly. No project is created implicitly. A missing project can be created from the existing personal-project directory.

Specialist workspaces use a compact host toolbar rather than the generic console heading. They keep the workspace's own navigation and content, plus the host's project switcher and responsibility editor. The selected project is reflected in the URL; an unauthorized explicit deep link is never silently redirected to a different project. Empty assignments, unavailable templates and catalog errors each have an actionable state. The `employee` CLI/API/manifest names are unchanged for compatibility.

If a page was open across a build update and its lazy-loaded files are no longer available, the console retains the current page and offers **Reload and open** for the intended destination. It does not automatically discard the current page or enter a reload loop. Application HTML is revalidated and missing assets are not cached.

**All projects is a standing policy; Selected projects is a snapshot.** An upgrade preserves the selection of existing employees until the user explicitly enables the new policy. Archived projects are unavailable. For an existing employee, use **Manage assigned projects** in its details or workbench; the older assignment action routes to the same editor. Removing a project ends its assignment with temporal history and excludes it from all-project management; it does not delete the employee, project, board, or tasks. Existing archived-project history and unavailable exclusion IDs are preserved.

The directory's **Filter projects** control supports multi-selection and inversion but only changes which Agents are shown. Its unrestricted view includes unassigned Agents; employee project views use effective responsibility, not ended history. Filtering never changes permissions or preselects additional projects in the editor. The editor retains its last-read baseline even if another consumer refreshes the catalog. The workbench's **Currently viewing** selector switches one isolated board; its separate management action edits responsibility. Future-project policy coverage does not fabricate Provider assignment history.

Repeat recruitment is idempotent. Customized profile preferences and executor/model policies are preserved. One employee identity can have multiple project assignments. Reactivating an inactive identity is an explicit action; a conflicting unrelated identity is never overwritten. Recruitment does not start an executor or constitute model usage.

The catalog shows whether a workbench package is actually installed. Identity-only templates need no runtime and remain valid employees without a sidebar workbench. A trusted built-in template may declare `workbench: { "kind": "native", "view": "people" }`; Bole uses this native panel to summarize Agent distribution, current tasks, and timestamped recruitment reasons from the same Project Agent APIs used elsewhere in the console.

## Local installation

```sh
fl employee install <built-package-directory>
fl employee install <built-package-directory> --replace
```

An optional `--runtime-config <file>` selects a specific existing FULI runtime. The command only installs the local directory supplied by the operator. It does not download a package, execute an install script, change Agent client settings or start another server.

Packages live under the configured FULI data directory, separately from employee board data. Changed packages require `--replace`; upgrades keep a backup and never overwrite board data. Content identity is verified from the files, not merely from the installation receipt. A loaded runtime changes after FULI restarts.

Only a regular `.installation.json` at the package root is excluded from content identity as host-generated metadata. File-type validation still rejects receipt symlinks before installation can write through them. Files with that name in subdirectories remain package content: changes require an explicit replacement, and directory contents still undergo normal validation.

**Installed runtimes are trusted JavaScript running with the host's privileges, not sandboxed plugins.** Only install trusted packages. Path confinement, manifest validation, size limits, rejection of symlinks, `.env`, `.git` and `node_modules` protect the installation boundary; they do not make malicious runtime code safe.

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

`employee.bole` is additionally reserved as the only system HR identity. Its Provider type is `hr`; other identities cannot claim that type. Recruitment history records the coordinating and HR Agent IDs, time, reason, proposed identity and final recruited identity, which powers Bole's people panel without inventing activity.

## HTTP and MCP

The host serves `/api/employee-templates`, recruitment/workspace/tool endpoints below it, and `/employee-workspaces/<template-id>/<project-id>/…`. Existing Host/Origin, JSON-body and LAN authorization checks apply. All workbench requests require an active matching identity and authorized responsibility policy, including assets and Agent discovery. Selected mode additionally requires an active assignment; all mode includes future active projects but enforces explicit exclusions and ended assignments before reaching the runtime.

The existing FULI MCP exposes `list_employee_templates`, `recruit_employee`, `list_employee_tools`, and `call_employee_tool`. Workbench operations resolve an exact registered `projectPath`; unresolved or mismatched projects fail closed. Clients need to rediscover tools after upgrading the FULI installation they launch. Editing a source checkout does not update an already installed server or active MCP session.

Recruitment accepts an exact `projectPath` (MCP), a legacy `personalProjectId`/`personalProjectIds` selection, or a `management` policy; legacy project selectors cannot be mixed with a policy. Policy shape: `{ mode, projectIds, excludedProjectIds, titleMode, titleStyle }`. `all` stores exclusions and no inclusion list; `selected` stores a fixed project list and no exclusions. Omission for a new identity uses the template default; explicit empty selection recruits without an assignment. Arrays are deduplicated and bounded to 500 entries, and validated before writes. Existing policy replacement requires `replaceAssignments: true` plus the last-read `expectedAssignmentsVersion`. A stale selection fails with `assignment_scope_conflict`; an identical retry is idempotent. Changes preserve customized preferences, role, and executor policies.

Management policy is stored beside the employee data in SQLite with cross-process compare-and-swap protection. It is saved before Provider changes so excluded access fails closed even after a partial failure. Assignment changes are individually durable, not one Provider transaction; removals precede additions. If a batch fails, `assignment_update_incomplete` requires reloading actual state before retrying. Receipts include the new version, policy, counts, and records. MCP results remain bounded and may report `truncated`; never treat truncated assignment records as a complete scope. Workbench, task entry, A2A and tool-call gates enforce the current policy on every request.

Jefa supplies eight workbench tools for board/task reading, task creation, optimistic-concurrency updates, status questions, and session-title preparation/receipts. Its data and in-process API/A2A implementations belong to the Jefa package; the host does not import a Jefa dependency or bind another employee port. Title settings allow automatic actions, suggestions, or off. Native rename execution belongs to the current client: the employee must not claim success before an actual client receipt, overwrite a manually locked title, or edit client databases/transcripts. Clients lacking native rename capability retain suggestions.

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

Run FULI's normal Node/web tests and typecheck. For an actual Jefa build:

```sh
node scripts/employee-package-smoke.js <built-package-directory>
node scripts/employee-package-smoke.js <built-package-directory> --serve
```

The smoke fixture uses a synthetic FULI directory but the real installed employee bundle, SQLite and MCP transport. The UI mode does not query a personal provider or external model. It deletes its temporary test data on shutdown.

Signing, remote catalog distribution, a runtime sandbox, database migration/uninstall UX, and production multi-user authorization remain separate release work. This feature does not authorize or publish a Feishu application.

### Bole identity upgrades

Local startup calls the idempotent system-HR endpoint for both fresh and existing installs.
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
