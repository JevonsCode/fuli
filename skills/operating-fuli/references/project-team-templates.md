# Portable project team templates (团队模板)

A team template copies how one project is staffed, not what it learned: who the
roles are, what each is responsible for, how they report, the procedures the
team confirmed, the checks it learned to accept, and its recurring lines of
work. Use it when the person wants a new project to start with the same team as
an existing one ("把 A 项目的团队搬到 B").

## What travels and what does not

| Travels (versioned, digested) | Never travels |
| --- | --- |
| Each role's occupation (`role`, `tags`), responsibility, capabilities, work kinds and `agentType` | Conversations, project memory, confirmed knowledge, preferences |
| Reporting lines, the lead, and sub-teams (lead and members) | Agent names, avatars, display names, profiles the person wrote |
| The team's active workflows: name, purpose, steps, work map | A workflow's `pitfalls`, source delivery, evidence, `personWords`, approvals, and its proposal state |
| A confirmed workflow's learned `trigger`, `scope` and acceptance checks | Any acceptance written as memory, a confirmation, or a passed result |
| Acceptance checks as target-bound references (`kind`, `text`, `occupation`) | The project lead's own routing rule, `branch:` terms, active triggers, grants |
| Recurring blueprints per role: responsibility and terms | Agent IDs, IDs of the source project, host paths, credentials, runtime or client access, model/executor policy, allowed clients |
| Acceptance checks and recurring blueprints as target-owned **drafts** | Active standing assignments, schedules, triggers, or any routine that runs or routes work by itself |
| The template lead's portable role and responsibility as a target-owned `leadSeat` draft | The target's existing lead Agent, its profile, occupation, credentials or access (never rewritten) |

The template is `fuli-project-team-template` version 1 and its `templateId` is
the digest of its portable content (`exportedAt` stays outside it). Exporting
an unchanged team twice gives the same `templateId`; a retry of an import can
therefore recognise its own earlier work. Do not edit a template by hand: a
changed body no longer matches its `templateId`, and it is refused.

## Which task may call these tools

All four tools require the current `taskContextToken`, and the task it names
must be bound to the exact `personalProjectId` in the call — not another
project of the same space. That is the scope check, and it runs before any
project read, local reference lookup or write:

- **Export** runs under a task in the **source** project (the team being copied).
- **Preview, import and read** run under a task in the **destination** project.
- A genuine move from A to B is therefore two independently authorized calls:
  export with A's task, then preview/import/read with B's task. One call cannot
  do both, and a task that works in A cannot export, preview, import or read B.
- No particular FLA or lead is required, so an authorized destination that is
  still empty accepts its team.
- A missing token is `invalid_input` and names `taskContextToken`. An
  unknown/expired token is also `invalid_input`. A valid token bound to another
  project is `project_mismatch` (409) and names both projects; it reads and
  writes nothing.

Only the description of a role, step or check travels. Free text written for
the source team can accidentally name an account, a credential, an absolute
host path, a private link, an email, a UUID or a source Agent/project ID. Export
replaces each such part with a redaction marker and counts the replaced fields
and dropped terms in `redacted`; it never repeats the value in the template or
in an error. A term, tag or capability that was changed is dropped instead of
being stored as a marker, because a marker would no longer match work. Import
sanitizes a template the same way before planning, so a hand-edited template
cannot re-introduce a secret.

## Export

`export_project_team_template` with the active `personalSpaceId` and the exact
`personalProjectId`. It reads only and returns
`{ status: "exported", templateId, template | templateRef, counts, redacted }`.
Pass the result back unchanged.

- The project must have a lead whose whole team is available and every role
  must have an occupation FULI can recreate; otherwise it fails with
  `team_template_team_incomplete` and exports nothing.
- Temporary Agents are not portable, and FULI's own built-in roles are peers of
  a team rather than its members. An Agent the team cannot recreate
  (temporary, unavailable, or without an occupation) stops the export instead
  of travelling half-described.
- Only active work travels. Proposed or retired workflows, and recurring lines
  owned by someone outside the team, are left behind.
- A project with no workflows, checks or recurring lines still exports; those
  sections are simply empty.
- A template of at most 16 KB arrives inline as `template`. A larger one is
  kept for this computer and space, and the result carries a short
  `templateRef` instead; pass that reference to preview and import on the same
  computer within seven days. An installation that cannot keep a reference
  refuses a too-large export with `team_template_too_large` (413).
- A template of an unsupported `formatVersion` is refused with
  `team_template_version_unsupported` (422); export it again from a FULI that
  writes a supported version.

## Preview, then import

1. `preview_project_team_template_import` with the same project, exactly one of
   `template` or `templateRef`, and optionally `roleAgentIds` (role key to an
   existing Agent of this space with the same occupation). It writes nothing
   and returns the plan: lead, roles with `action` (`create`, `reuse`,
   `mapped`), relationships, policy, workflows, acceptance, recurring jobs,
   `templateDraft`, conflicts, and a `confirmationDigest`.
2. If `status` is `conflict`, nothing can be written. Fix what the `conflicts`
   say (or name another project) and preview again.
3. If `status` is `ready` and the person's own instruction already names this
   destination, call `import_project_team_template` with the same template or
   reference and project. Do not ask a second generic approval. When a preview
   was shown and the person answered it, pass its `confirmationDigest` too; a
   stale or mismatched digest is refused with
   `team_template_confirmation_required` (409) and writes nothing. The digest
   is optional: omitting it does not grant anything the person did not ask for.

The target must be an explicit, authorized project of the active space. The
import never replaces a working team:

- **An untouched automatically staffed lead is filled, not refused.** A normal
  entry staffs a default project lead before the person can preview (one
  durable Agent with the generic `lead` occupation, one active assignment whose
  reason is `Every task needs a FULI Agent; this project had no team lead.`, at
  its initial revision 0 — or, for a legacy record without a revision, no
  update later than its assignment — and no other configured team). The import
  uses that Agent for the template lead role's seat: it keeps its identity,
  profile, occupation, credentials and access, and no Agent, assignment or
  profile is rewritten. If the target lead is not that untouched bootstrap lead
  — a person appointed, edited or changed it, its one assignment was ended or
  replaced, it is already working, or the project already has another team —
  the ordinary lead/member conflict still applies. A matching stored `leadSeat`
  binding from an earlier import still reuses the same seat on retry, including
  a locally edited assignment, and never updates that edit. A source lead with
  a different occupation (for example `engineering`) also fills the seat,
  because the target keeps its own `lead` occupation. An explicit
  `roleAgentIds` mapping for the lead role is used and checked normally, never
  silently replaced.
- `team_template_target_lead_conflict`: the project already has a different
  lead. Use a project with no lead or the same lead; a project can be given
  another lead only by the person, not by an import.
- `team_template_target_members_conflict`: the project has explicit members the
  template does not name; the import does not remove them.
- `team_template_target_subteams_conflict`: the project already has a different
  sub-team layout; the import does not rewrite it.
- `team_template_target_team_conflict`: the project's existing layout matches
  none of the template's; the import never rewrites a working team.
- `team_template_lead_unmapped`, `team_template_role_unmapped` and
  `team_template_recurring_job_lead`: a role (or the lead) could not be mapped,
  or the template names the lead as a recurring line's owner.
- `team_template_workflows_unavailable`: this installation cannot store the
  target's proposed workflows, so the template cannot be imported whole.
- `team_template_receipts_unavailable`: this installation cannot keep the
  imported acceptance checks and recurring blueprints, so a restart could not
  read them; nothing is imported until it can.
- `team_template_role_agent_not_found`, `team_template_role_agent_unavailable`
  and `team_template_role_occupation_mismatch`: a `roleAgentIds` mapping names
  an Agent that does not exist here, is not active, or has another occupation.
- `team_template_project_not_found`: no authorized project has that ID.
- `team_template_reference_not_found` (404): the `templateRef` is unknown,
  expired, or was exported by another space.

## What the import writes

Agents are created or reused under deterministic IDs
(`tt-<hash of project and role key>-<roleKey>`), assigned to the project with a
stable idempotency key, and the project's coordination policy is updated only
when its lead, members or sub-teams are still empty. When the target's
automatically staffed lead fills the template lead seat, that Agent and its one
assignment are reused unchanged: the other roles are added around it, and the
template lead's portable role and responsibility are kept in the target's draft
receipt as `leadSeat` rather than written onto the Agent. Then:

- Workflows are `propose_agent_workflow`-style proposals on the target Agents,
  under a target-owned `source` naming the project, role and workflow. They are
  never active: the person confirms each in the console. A learned workflow is
  proposed with its transferable `trigger`, `scope` and checks only, and it
  also waits for this project's person; the source delivery and the person's
  old words never travel.
- Preview reports each workflow as `propose` (new), `unchanged` (already this
  template's proposal) or `kept` (the target changed it after an earlier
  import). `kept` is never rewritten.
- Preview reports `lead.seat: "adopted"` with the Agent's identity and
  occupation when the target's untouched bootstrap lead fills the seat, and
  `lead.seat` is absent when the template lead is created or mapped normally.
- Acceptance checks and recurring blueprints are **not** written as memory, as a
  standing assignment, a schedule or a routing rule. The first import stores
  them once in a durable, project-bound draft receipt; preview reports
  `templateDraft.action` as `draft` (new), `unchanged` (same draft), `kept`
  (the target's stored draft differs, or the source changed since) or `none`
  (nothing to draft). A filled bootstrap lead seat is part of that same draft:
  `templateDraft.leadSeat` names the template lead role and the target Agent.
  Each check is `status: "draft"` with `kind`, a clipped `text` and
  `occupation`; each recurring job is `action: "draft"`, `"unchanged"` or
  `"kept"` with the role, responsibility and terms. Nothing runs or routes new
  work until the target person enables a check or a line, and the target's own
  human acceptance is never replaced.
- A first import wins the draft. A reimport after local edits, or after the
  source version changed, reports `kept` and never overwrites the target's
  stored checks or blueprints, just as it never overwrites a changed workflow.

The result is `{ status: "imported", applied, counts, templateDraft, ... }`.
Writes are durable one by one, not one transaction: a failure after some writes
returns `{ status: "partial", retryable: true, applied, failure }` and never
rolls back what the person can already see. Tell them what was saved, fix the
reported `failure`, and call the import again with the same inputs: created
Agents, assignments, workflows and the draft are reused, not duplicated. A
retry keeps the same bootstrap lead seat through the stored `leadSeat` draft,
or, when that draft was not yet saved, through the deterministic target IDs the
import gave its members. A concurrent or repeated import makes the same stable
writes, so it cannot add a second role, workflow, check or blueprint.

## Finding the imported draft after a restart

The draft belongs to the target project and is read through the team the person
already reads:

1. `get_project_team` for the project. When a template was imported it includes
   `importedTeamTemplate: { status: "draft", templateId, importedAt,
   leadSeat, acceptance, recurringBlueprints, readWith:
   "read_project_team_template" }` — counts and, when a bootstrap seat was
   filled, the template lead role and Agent only; small enough for the team
   answer.
2. `read_project_team_template` with the same `personalProjectId` (optional
   `limit`, default 20, maximum 50) returns
   `{ status: "draft", leadSeat, acceptance: { total, items },
   recurringBlueprints: { total, items }, truncated, next }`. `leadSeat` names
   the template lead role, the target Agent, the portable occupation and a
   clipped responsibility, and says the Agent itself was not changed. Each
   item's `text` or `responsibility` is clipped for one bounded answer; the full
   text stays in the local store.
3. With no import in this project it returns `status: "none"`. Reading changes
   nothing and turns no draft into memory, a schedule or a routing rule.

The normal route is the team read: a new session calls `get_project_team`
first, sees `readWith`, and reads the draft only when the task needs it. The
receipt is one versioned local file per project, so it is found again after
FULI restarts or the local store is reopened.

## Boundaries

- Preview and export are reads; only `import_project_team_template` writes, and
  only for an explicit destination the person named.
- An import never starts work, recruits beyond the template, activates a
  workflow, registers a standing line, creates a schedule, grants access or
  changes a lead.
- `scope_mismatch` (403) means the `personalSpaceId` is not the active space;
  use the active one, never another project's IDs.
- A template is the person's team description, not knowledge: do not save it as
  a memory item or a preference unless they separately ask for that.
