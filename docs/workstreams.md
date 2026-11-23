# Workstreams (工作线)

One project often carries several lines of work that share a repository, a
release process and components, but nothing of their business logic: pages,
campaigns, small internal projects. Without a boundary they all land on the
project lead, and its project memory and work log mix them together.

A **workstream** is one such line of work inside a project: a name, what
recognises it, and the one FLA that does it. When a task belongs to a line,
that FLA is this turn's FLA: it works as itself, with its own memory, and its
records are its own. The project lead keeps the ledger; the person can change
it at any time.

Nothing is split that was already recorded. A workstream starts from the day
it is opened and claims no earlier task.

## It is a standing assignment

A workstream is stored as a standing assignment
(`src/standing-assignments/`): confirmed terms for a kind of work, pointing at
one project and one Agent. A project-level standing assignment points at the
project's lead and routes work into the project; a workstream points at a
member of the same project and divides work inside it. The two are one record
type, one store, one set of corrections and one temporal history. The store
format is unchanged.

Why not a sub-project (`PART_OF`)? A sub-project is a separate project with
its own lead, brief, knowledge scope and memory. It separates the shared
things too — the release process, the component conventions, the project's
pitfalls — which is exactly what should stay shared here. A sub-project is
still the right answer when a small project really has its own repository,
release and team.

| | sub-project | workstream |
| --- | --- | --- |
| shared release process, components, conventions | separate | shared |
| business context, decisions, progress | separate | separate |
| its own lead and project page | yes | no |
| cost of opening one | onboarding, a lead | one call |

A workstream is not the `workstreamBoundary` of a
`coordinate_project_agent_task` plan. That boundary is one task's split and
ends with the task; a workstream lasts until it is ended.

## Which workstream a task belongs to

```mermaid
flowchart TD
    T["一条任务进来\n请求文字 · 工作目录 · 当前分支 · 会话上一轮"] --> S{"人点名了 FLA / Agent？\n（含本会话之前的 #FLA）"}
    S -- 是 --> P["按人说的走，直到人点名别人或 #FLA 结束\n点名的若正是某条线的负责人，就由它作为本轮 FLA；\n这一轮说到它自己那条线时，任务才记在这条线上"]
    S -- 否 --> H{"组长把任务交给某条线？\n（begin_task_context workKind \"workstream:线名\"）"}
    H -- 是 --> O
    H -- 否 --> W{"本项目哪条线命中？\n用词优先，其次项目根以下的目录名、分支名\n指向组长的规则不算线"}
    W -- "正好一条" --> O["这条线的负责人作为本轮 FLA\n用它自己的记忆，记录记在它名下\n换人或换线的那一轮写明：哪条线、谁接手、为什么"]
    W -- "好几条" --> A["留在组长手里，问一次属于哪条"]
    W -- "命中指向组长的规则" --> L
    W -- "一条都没有" --> C{"本会话上一轮归了某条线？"}
    C -- 是 --> O
    C -- 否 --> L["留在组长手里\n组长按账本判断：属于某条线就交给它；\n是新的无关工作就开一条线；拿不准自己做"]
```

Decided at task entry, deterministically, with no model:

1. **The person named someone.** A named FLA (`#FLA`) or an explicit Agent. A
   workstream never overrides it. `#FLA` binds the session: its later turns
   stay with that FLA, whatever line their words name, until the person names
   another FLA or sends `#FLA 结束`, which gives the session back to the lines
   (the turn that ends it, and the turns after, route as below; a named turn
   never carries a line on). A request may follow it in the same message
   (`#FLA 结束 桌面端那个按钮`): the binding ends and the request routes as
   below. Only when the whole text names an FLA (one called "End Rivers") is it
   that FLA instead. The turn the name takes effect says so once:
   「…；之后本会话都由它做，不再按工作线分派，发 #FLA 结束 恢复」. Naming the FLA
   that owns a line of this project makes that FLA this turn's FLA, exactly as
   a matched line does. The turn counts on its line in the ledger only when
   its words, folder or branch name that line; anything else it does while
   named is not that line's progress.
2. **The lead handed it to a line** (`begin_task_context` with
   `workKind: "workstream:<name>"`, see below). That line's owner works this
   turn; nothing is bound.
3. **A line of this task's project matches.** Only lines of the project the
   task is already in apply, by three signals:
   - **Its words** occur in the request, as a whole term
     (`src/standing-assignments/term-match.js`).
   - **Its folder**: a term is a whole folder name below the repository root of
     the working directory. Folders above the root — the user name, the
     repository's own name, `code`, `src` of other checkouts — are never read.
   - **Its branch**: a term `branch:<name>` matches the current Git branch
     exactly, and `branch:<prefix>/` matches every branch under that prefix.
     The branch is read from the repository's files within 250 ms
     (`workingRepository`, `src/conversations/working-branch.js`); a slow drive
     leaves it unknown.
   A line its words name outranks another line's folder or branch: saying
   「优惠券」 inside the folder of another line goes to the 优惠券 line, with no
   question. A request that names this project, or an explicit project id,
   keeps its lines: naming the project says where, not who.
   A standing assignment of this project that points at its lead is the
   person's rule for the lead, not a line (the ledger leaves it out too): when
   its words match, and no line's words do, the lead works this turn, and the
   entry says the FLA changed if the session's last task was a line owner's.
4. **More than one line matches** → the task stays with the lead, and the
   entry asks the person once which line it is.
5. **None matches, but this session's last task belonged to a line** → the
   session goes on with that line, until another line or the lead's rule
   matches, the person names someone, or the line ends. A line merged into
   another goes on as the line it went into.
6. **Nothing matches** → the task stays with the lead.

Only the person's own project-level standing assignments still move a task
into another project, and only by their words. A line the lead opened, a
folder and a branch never move a task between projects: "改首页按钮" in
another project stays there even if some project has a line called 首页, and
a path such as `C:\Users\admin\code\other` never matches a term `admin`.

## Who works when a line matches

The line's owner is this turn's FLA (`selection_reason: workstream_owner`).
It loads its own project memory; its session summary, work log, checkpoint
and receipt are its own; nothing of this line reaches the lead's memory.

The entry says it only on the turn the FLA or the line changes, with why, and
where the session's earlier work is when someone else did it:
「工作线「春促落地页」由 Ember Vale 接手（因为提到「春促页」）」,
「…接手（组长交给它）；本会话之前的进展在组长的记录里」,
「…接手（延续本会话上一轮）；本会话之前的进展在 Fern Holt 的记录里」. The
reason is a word, a folder (因为在目录 … 下), a branch (因为在分支 … 上), the
lead's hand-off or the session's last turn; the field carries it in English
too (`reason_text`). Later turns of the same line by the same owner say
nothing more: they keep the line on the task, and the entry carries only
`standing_owner: { status: "workstream", assignment_id, workstream }`, so the
owner still knows its line after the client compacts its context.

This relaxes, for one case only, the rule that the project lead owns every
conversation of its project and that a named member is merely requested
(`project_lead_reporting`, "do not load the specialist's private memory").
That rule protects a member's private memory from a session the lead holds:
the lead asking a member something, or a person naming a member inside the
lead's conversation. It still holds there. The exception applies only when
FULI's entry itself names the owner of an active line of this project, for an
active, non-peer member that this client may run, never the lead and never
for a delegated worker turn. The Provider checks each of those again
(`workstream_owner` in `store_project_agent_context.py`). The lead stays
accountable for the project: the ledger shows the line's progress.

When the owner cannot work this turn the task stays with the lead and the
line says why, by name: the owner is not available in this client, or is no
longer on the project — then the ledger offers to give the line to someone
else.

## The lead divides the work

When nothing matched, the task is the lead's. The entry gives every FLA of a
project that has lines the lines as facts (name and owner); only the lead also
gets one short rule, delivered by reference
(`fuli://rules/task-entry/workstream_guidance`):

- the work belongs to a line → hand it to its owner;
- it is a new piece of work unrelated to every line → open a line for it;
- unsure → do it yourself.

Handing over is one call: `begin_task_context` with
`workKind: "workstream:<line name or ID>"` and the request as `taskPrompt`.
It rides on the existing `workKind`, so no client pays for a parameter only a
lead of a divided project uses. In any entry that takes a `workKind`
(`get_collaboration_preferences` included) the prefix, in any case, is a
hand-off and never a kind of work: it scopes, stores and filters no
preferences. A line's name is therefore at most 117 characters (128 for
`workKind` less the prefix); a longer one is refused when the line is opened
or split off (`workstream_name_too_long`). The owner
then works this turn as itself, as above, and the session goes on with the line
like any matched one: the person's next words still decide. The lead never
uses `#FLA` for this: that is the person's own choice of FLA and binds the
whole session.

The entry always says what became of a hand-off (`workstream_handoff`). Only
`status: "handed_over"` means the owner took it; the lead stops working on the
task only then, and asking again in that turn says `handed_over` again. Every
other answer names why and says the task is still the caller's, to do itself.
Apart from that answer, a hand-off that does not happen changes nothing: the
turn is routed exactly as if the `workKind` had not been sent, by its words,
folder and branch or the session's own line, and a later entry of the same
turn keeps that turn's FLA.

Who asks is the FLA of the session's task in this project. Before the session
has one (an entry without a session ID, a hook that failed, a task in another
project), it is whoever this turn goes to without the hand-off: with no line of
its own that is the lead, which may hand over; a turn the request gives to a
line is that owner's, which may not; one FLA cannot place (the request names
several lines) is `no_session_task`, with the next step, never "not the lead".
Whether the caller is the lead is settled before the name is looked up.

| status | reason | when |
|---|---|---|
| `workstream_not_found` | `no_such_workstream`, `no_workstreams`, `no_project` | no active line of this project has that name or ID (an ended one included), the project has no lines, or the task is in no project |
| `workstream_handoff_refused` | `not_lead`, `lead_unreadable`, `no_session_task` | the caller is not this turn's lead (a line's owner or a worker cannot hand work around), FULI could not read the project's lead, or the session has no task yet and this turn cannot be placed: begin it without the hand-off, then hand it over |
| `workstream_handoff_held` | `named_fla`, `explicit_agent`, `group_discussion`, `person_rule`, `internal_activity`, `unavailable`, or the owner's own reason (`workstream_owner_not_on_project`, `client_not_allowed`, …) | the person's `#FLA` (this message or the session's binding), an explicit `projectAgentId`, a group discussion or the person's own rule outranks it; or the owner could not take the turn |

## Opening, correcting and ending one

The project lead opens one with `register_standing_assignment`
`change: "delegate"`: the terms, the line's name and the member that takes
it. It is recorded as the lead's (`source: "host"`), in one call, without the
person's confirmation, and its result carries `tell_user`, the sentence the
lead passes on: which line, to whom, which words and branches. Only the terms
the lead names are recorded; a branch is a term only when the lead names it
(`branch:<name>`), and the preview and the result list branches apart.

- **One line per FLA per project.** Giving a second line to an FLA that
  already has one is refused, naming its line, with three next steps: add
  these terms to its line, pick another member, or have Bole recruit one.
- **Not to the lead.** A line that stays with the lead needs no workstream.
  Handing a line back to the lead is ending it.
- **Terms that would match everywhere are refused**: a term of one Han, kana
  or Hangul character, or under three characters otherwise, and common words
  such as 页面, 修改, bug, page, web, admin, src. Han, kana and Hangul run
  together with no word boundary, so a two-character term such as 性能 or 上线
  occurs in requests about anything: a term the lead adds needs three. The
  person may still use two on the project page, which says once that it is
  short. A branch everyone shares
  (`main`, `master`, `develop`, `release`, …) is never a branch term: the same
  list that keeps such a branch from proving two sessions continue one piece of
  work (`sharedBranch`, `src/conversations/continuation-decision.js`).

The lead corrects its own lines the same way, in one call, and they stay the
lead's. A line the person opened or confirmed is the person's: the lead
cannot change it, and the person changes it through preview and their yes,
or in the console. The person's own reassignment may move their rule to the
lead or another project; its sentence then says the line leaves the ledger.

- **「这个还是让 X 做」** — `change: "reassign"` naming the member. A line is
  never reassigned to the lead by default.
- **merge** — one line's terms move into another and the first ends, as one
  change (`POST /api/standing-assignments/:id/merge`).
- **split** — some terms leave a line and open a new one for another member,
  as one change (`POST /api/standing-assignments/:id/split`). If the new line
  cannot be opened, the old one keeps its terms.
- **end** — `change: "retire"`. Its terms are free again; its record and
  every revision stay.

In the console the person's own clicks are recorded as theirs. An FLA acting
for the person there (`run_delegated_action`) is recorded as an Agent's
(`source: "host"`) and may do it only as the lead of that project.

## Memory

Project memory and the work log are keyed by `(space, project, Agent)`, and
the line's owner is the turn's FLA, so its memory and records hold that line
only. What the whole project shares — the release process, component
conventions, pitfalls — is project knowledge, which every member reads
through the ordinary project-scoped search. It is not copied into anyone's
memory.

## The lead's ledger

One line of work answers four things in one place: **which project, which
line, who, how far**.

```text
Campaigns · 春促落地页 · Ember Vale · 进行中：改头图（2026-11-23）
Campaigns · 优惠券中心 · Orin Pike  · 已完成：接券接口（2026-11-21）
```

How far comes from the owner's work log in that project: the latest task
marked with this line, not earlier than the line's start. A task a line took
keeps it in its match basis as `workstream:<assignmentId> <notice>`, so an
owner change never rewrites it. A line with no such task says 还没有任务; a log
that could not be read says so, never 还没有任务.

`get_project_team` returns the lines with that progress. The project page
shows them and changes them by clicking: owner, a word less (each word's
remove button), merge, split, end. A merge or an end is asked once first,
saying what happens and that it cannot be undone in one step (a merge is
split again, an ended line opened again). Ended lines stay listed, folded,
newest first. How often each word matched is not shown: an entry records
which line took a task, not which word, and keeping that would be a new
record. The
ledger widget (`workstream-ledger`) shows one FLA's lines — every line of a
project it leads and the line it owns — and links to the project page for
changes. Both are on this computer only: over the LAN the team is shown
without its lines, and the widget says it can only be read here.

Earlier tasks are not reassigned. The ledger's start date is the honest
boundary: work before it was not under any workstream.

## Cost

- No model call, ever.
- A task in a project without lines costs nothing new: no read, no marker.
- A task in a project with lines reads the repository and branch from disk
  (at most 250 ms) — the same read the task's beginning uses for its
  conversation and continuation line, so it is read once. When the request
  matches an assignment of the project, or the lead hands a task over, it
  reads the project's lead (to tell the person's rule for the lead from a
  line); a session going on with its line does not. That read is shared by
  the whole entry — the routing, the named FLA's notice and the team block
  (`src/graphiti/project-policy-read.js`) — so one entry asks the Provider for
  the lead at most once. When a line takes the turn, it makes one more
  Provider request to select its owner.
- A line's notice is sent once, on the turn the FLA or line changes.
- The entry carries the lines' names and owners only when the project has
  lines, and the rules reference only to its lead; that is counted in the
  token budget. The hand-off adds nothing to any tool schema.

## Interfaces

- `register_standing_assignment` — `change: "delegate"` opens a line;
  `reassign`, `edit_terms`, `retire` correct or end one.
- `begin_task_context` with `workKind: "workstream:<name>"` — the lead hands this turn to a line's owner; `workstream_handoff` says whether it happened.
- `#FLA <name>` / `#FLA 结束 [request]` — the person binds the session to one FLA, or gives it back to the lines.
- `get_project_team` — `workstreams`, with `latestTask`.
- Console, this computer only: `GET /api/project-team`,
  `GET /api/workstreams?agentId=|personalProjectId=`,
  `POST /api/standing-assignments`,
  `POST /api/standing-assignments/:id/(retire|reassign|terms|merge|split)`.
