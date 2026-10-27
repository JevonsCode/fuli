# Coordinating Project Agents

Part of the capturing-session-knowledge Skill; read SKILL.md first.

## Coordinate Project Agents

Use a project Agent team only when the user requests delegation or the host's active delegation
policy authorizes it and the task has independently verifiable work. Keep one primary coordinator
responsible for decisions, integration, and final verification. Do not split a small or tightly
coupled task merely to create more workers.

For an eligible task, call `coordinate_project_agent_task` once with the exact current
`projectPath` when available, one stable idempotency key, an explicit complexity hint when known, and focused
context queries. Enable its parallel plan only when there are at least two conflict-free
workstreams with independent verification; state each workstream boundary. The Provider chooses
the lead and collaborators from active project assignments, preferring Agents with relevant
project history. Explicit user-selected Agents and locked policies remain higher priority.
When no registered project matches, coordination may return an isolated temporary project;
keep its exact returned ID for this task. Ambiguous candidates still require a choice. Temporary
scope creation is not Agent recruitment approval or proof of execution; follow the returned
recruitment/authorization state and worker plan. When you recruit with a `recruitmentProfile`, read
`get_agent_naming_style` first and give its `displayName` in the person's style (omit it when the
style is `null`); on `agent_name_taken` propose another free name in that style, and tell the person
if you cannot find one.

Treat the returned durable Agent identity and a host worker as different things. A durable Agent
keeps its project assignment, preferences, task history, and Agent-scoped graph memory while idle;
the host creates an execution process only when needed. Start only entries in `worker_plan`, give
each worker only its returned isolated `context` (including `lifecycle`), role, and workstream boundary, and never expose
another Agent's private context. Fuli is the control plane and does not itself prove that a native
worker started.

`@FLG … 一起看` (task entry `flg.status: together`) is not coordination: no member is woken and no
worker starts. The session reads `flg.context`, a read-only index of the confirmed members (their
projects, standing responsibilities, latest tasks and matching knowledge titles; their working memory
is withheld). Checkpoint the task as the session's own Agent only: never list a member as a
collaborator, never write a member's `agentMemory`, and capture a fact learned from a member's
context only after reading the full item it comes from.
Do not forward the parent's task token. The coordinator alone checkpoints the shared host task
after integrating worker results; a worker's completion is not that task's completion.

The host adapter must keep an adaptive-runtime graph lease for the whole worker run, and an
executor lease when Fuli manages that executor. Call `acquire_runtime_lease` before starting
workers; its MCP process keeps the heartbeat alive. Call `release_runtime_lease` in a `finally`
path after all results and terminal events are recorded. Record queued/running and terminal state
with `record_project_agent_task_activity`,
including concrete worker identity. Call `record_project_agent_executor_actual` only after real
executor/model use. If the host cannot start a worker, report the task as blocked or failed and do
not fabricate an execution-summary row. The Provider's `executionSummary` remains authoritative.
A blocked report should say what it waits for; the Provider records when and in which session.
The block clears itself when that same session continues (a checkpoint or a new prompt there) or
the person answers its request; activity in another session does not clear it, so do not report
the task running from elsewhere to work around a block. Only the person can mark a block cleared
otherwise (「标记为已解除」 in the console); no Agent tool does it.

`workerStatus` requires `workerId` and the participating `agentId`. Structured actual executor,
provider and model form one report and must match authorized preflight evidence. When that
evidence is missing or inconsistent, omit all three; preserve the observed `workerRuntime`,
terminal status and mismatch in the summary. Do not guess a provider or rewrite preflight to
make history fit. Valid terminal activity automatically creates its routing outcome. Additional
user/test outcome evidence needs a matching recorded execution, the task's exact work kind and
model strategy, and real references; a CLI session ID alone does not establish that execution.

Keep per-worker completion separate from the global task transition. While parallel work is still
being integrated, report each worker's terminal result in `workerStatus` and keep the task status
`running`; this preserves one terminal execution-summary row per actual worker. Only after every
required worker or participant result has been recorded should the coordinator send the final task
`completed`, `failed`, or `cancelled` activity. Never let the first completed worker close the task
before the remaining workers have reported their tools, session evidence, and exact Token usage.
A worker report that arrives after the coordinator completed, cancelled or paused the task is kept
as that worker's history and leaves the task status unchanged; record it once and do not retry it
as a status change. In a team without sub-teams, the Agent dispatching from its own task becomes
the new task's coordinator: omit `coordinatorAgentId` rather than naming the project lead.

## Report Actual Worker Execution

When a FULI task or task view returns a non-empty Provider `executionSummary`, append a compact
Markdown table with one row per actual worker. Include the worker label and occupation emoji,
actual executor/tool and `workerRuntime.application`, work summary, terminal `workerStatus`/status,
worker session (`workerRuntime.sessionId`, or a worker session link only when supplied), and Token usage.
Label `sourceApplication` and `sourceSessionId` separately as the reporting host. They do not
identify an external worker; do not substitute them for missing worker evidence.
Use only the source-labelled cumulative `tokenUsage` reported for that worker. If it is absent,
show `-`; never estimate it or copy a conversation-wide total into a worker row. If no
worker session link exists, show `workerRuntime.sessionId` or `not reported`; never invent a link. This applies only
to Provider-reported actual workers. When empty `executionSummary` is returned, omit rows; an absent
`executionSummary` also omits rows. Configured, allowed, or available clients/executors are not evidence
of actual use. Keep this Agent-agnostic; client-specific details and work-kind routing remain at
adapter boundaries.
