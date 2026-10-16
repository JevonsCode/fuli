# Explicit local worker dispatch

The coordinator still owns acceptance and parent-task completion. The opt-in host
can dispatch one queued, ready lead worker using the task's existing executor
decision. Multiple workers, missing context, or an unbound executor return
`blocked`; no native process starts in those cases.

Run `fl worker dispatch --bindings <local-bindings.json> --runtime-config
<graph-runtime.json>` and pipe one JSON object containing `plan` (the actual
`coordinate_project_agent_task` result) and an explicit `idempotencyKey` on stdin.
The input limit is 1 MiB. Keep the plan and its parent token in memory; the command
does not save or echo them. The assigned prompt is the routed task's objective.

The bindings file is trusted local host configuration, separate from Provider
executor registration and the model-facing plan. It contains no credentials:

```json
{
  "version": 1,
  "bindings": [{
    "personalSpaceId": "my-space",
    "personalProjectId": "my-project",
    "executorId": "my-authorized-executor",
    "application": "codex",
    "projectPath": "T:/isolated-worker/workspace",
    "adapterPath": "T:/tools/adapter/dist/index.js",
    "codexPath": "T:/tools/codex/codex.exe",
    "codexHome": "T:/isolated-worker/home",
    "leaseExecutor": false
  }]
}
```

Every path must be absolute, exist, and have the correct file/directory type.
Daily Codex home (including descendants), the user's home itself, unknown fields,
and duplicate scope/executor bindings are rejected. Use an independently prepared
isolated home and workspace. The command does not copy authentication, log in,
change workspace trust, or infer executable paths from executor registration.
`leaseExecutor` is true only for an executor managed by FULI; the graph lease is
always acquired through the existing runtime lease client.

The server's explicit `workerRuntimeBindings` Map uses the same binding records,
keyed by `workerRuntimeBindingKey(spaceId, projectId, executorId)`, and exposes
`workerPlanHost.dispatch({plan, idempotencyKey, signal})`. The coordinate MCP tool
continues to return a plan without launching a worker.

Each attempt polls its WorkerRun sequentially every second, bounds each read to
five seconds, and ends after at most thirty minutes. Closed/revoked authority or
SIGINT/SIGTERM cancels the existing worker signal; the owned run, process, and
leases follow the existing cleanup. Authority-read failure also stops the
attempt. There is no retry scheduler or automatic parent completion.

CLI output contains only the run outcome, actual session identity, reporting and
cleanup evidence. Exit codes are 0 for a completed child checkpoint, 2 for blocked,
130 for cancellation, and 1 for failure or incomplete evidence. A successful
child checkpoint does not establish real model/provider use or coordinator
acceptance.
