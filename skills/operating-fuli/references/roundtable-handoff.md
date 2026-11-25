# Roundtable work handoff (圆桌工作交接)

A normal FLA-to-FLA `message_agent` ask carries a short, bounded index of the
**sender's** finished work in the same project, so the FLA that takes over knows
what was just done, what proves it and what is still open. The recipient never
has to be given the sender's result by hand.

## What the recipient gets

The handoff travels on the ask itself. It is rendered in the wake prompt after
the usual header, sender and body:

```
接手交接：Milo Reed 已完成的工作（同一项目，近 48 小时，最多 10 条；请接着做）
- 已完成 2026-11-24 09:10 UTC · installer 构建与冒烟测试 [task task-123；quality gate passed；revision rev-7；run run-9；source codex]
  结果：安装包已产出，冒烟通过
待接手：启动检查（in_progress，task task-456）
另有 2 条未列出。
读全量：view_project_agent_task(personalSpaceId="…", taskId="task-123")；list_project_agent_tasks(personalSpaceId="…", personalProjectId="…", agentId="…")
```

Each completed row carries the time, what was done, the task ID and the
evidence recorded on that task: quality gate, verified artifact revision, run
ID and source client, plus a short result summary. `待接手` lists the sender's
recent open tasks. `另有 N 条未列出` counts rows left out, never hides them.

The same block is in the recipient's ordinary inbox: `read_agent_messages`
returns each waiting ask with a `handoff` string. Because it is stored with the
ask, an already-running recipient and one that restarts mid-task read the same
block; it is not only a wake prompt. The unbound `read_agent_thread` view, which
takes only a thread ID and is space-wide, does not render this added handoff: it
stays on the recipient- and session-scoped inbox and wake.

## Where it comes from

Only the sender's own task records in the one project the ask belongs to: task
ID, title, status, result summary, quality gate, verified artifact revision,
run ID, source client and timestamps. Nothing else is read:

- no other Agent's task records or working memory;
- no roundtable message bodies or another thread;
- no session transcripts and no checkpoint work logs.

The source task reference is bound on the host: `handoffTaskId` names the task
the sender finished, and the host accepts it only when that task is in this
project and the sender leads or participates in it. Omitting it uses the
sender's own task at the task entry; when that task is still open, the host
falls back to the sender's latest finished task in the project. Explicitly
naming an open task lists it only under `待接手` and does not add unrelated
finished work; explicitly naming another Agent's task or a missing one yields no
handoff at all. A listed task still has to prove
`task.personalProjectId === projectId`. A task the sender cannot prove is its
own is never handed off. A missing or unreadable record leaves the ask exactly
as it was.

## Bounds and freshness

- Window: 48 hours before the ask.
- At most 3 completed rows and 3 open rows, and never more than 10 rows.
- The whole block stays within 2400 actual UTF-8 bytes, counted with every
  field and with the rendered text; long titles, summaries, evidence and source
  values are clipped, and rows are dropped and counted in `另有 N 条` rather
  than exceeding the bound.
- A future timestamp or one older than the window is ignored.
- Evidence is minimal: only what the task record itself says.

## When it is included

Only a normal, local FLA-to-FLA ask in one project:

- the sender is an active FLA with a task context in the project;
- the recipient is a resolved Agent in the same project;
- the ask wakes a client or waits in the recipient's inbox.

It is **not** included for:

- Agent chat rooms, personal conversations or anything carrying `chatWake`;
- read-only group-discussion turns (`wakeMode: "read_only"`);
- cross-project asks (`project:<id>` or an Agent assigned only elsewhere);
- asks from a runner or another paired computer (read-only, FULI-only wake);
- asks without a sender task, or when the sender's task records are unreadable.

An unavailable read, an empty window and an expired window all leave the ask
and the wake prompt as they were; the ask still runs and answers.

## Reading more

The block is an index, not a copy. Use the normal reads with their real inputs:

- `view_project_agent_task` with `personalSpaceId` and `taskId` for one task
  and its events;
- `list_project_agent_tasks` with `personalSpaceId`, and optionally
  `personalProjectId` and `agentId`, for the project's task list;
- `search_current_project_knowledge` for the project's confirmed knowledge.

## Verification

`test/agent-roundtable-handoff.test.js` covers a public A→B scenario (A has
finished work with evidence and follow-up, B is unprimed), the ordinary inbox
plus wake, a receiver restart, the raw thread-by-id read returning no added
handoff, another session, another project and a paired device that cannot read
it, ordinary ask bodies unchanged, unreadable records, future and stale tasks,
bound open/foreign/missing tasks, a listed task from another project, the
10-row/2400-byte cap with huge fields and a long multibyte space ID, and a host
without the optional handoff method.
