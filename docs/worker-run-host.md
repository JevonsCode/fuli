# One WorkerRun host attempt

`createWorkerRunAttempt` is a host-only JavaScript port for one already authorized,
bounded worker attempt. It is not exposed as an Agent tool. The coordinator still
selects the participant and exact authorized executor/model, supplies the parent
task context, accepts the result, and finishes the coordination task.

```js
import { createWorkerRunAttempt } from './src/graphiti/worker-run-host.js';
import { createCodexAcpWorkerAdapter } from './src/agents/codex/acp-worker.js';

const attempt = createWorkerRunAttempt({
  provider, // GraphitiProviderClient for the selected personal space
  leases,   // createRuntimeLeaseClient; owns the heartbeat until release
  adapter: createCodexAcpWorkerAdapter({
    adapterPath, codexPath, codexHome, runtimeConfigPath
  }),
  request,  // WorkerRunPrepare fields except runtime_capability_hash
  projectPath,
  taskPrompt, // only this worker's bounded assignment and isolated context
  toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'],
  leaseExecutor: false // true only for an executor managed by Fuli
});
const result = await attempt.run({ signal });
```

The host acquires a graph lease (and an explicitly selected managed executor
lease), loads the exact parent context, prepares the run with a capability hash,
and claims its start before creating a child. A false or uncertain start claim
never launches or closes another host's run. Repeated calls on the same attempt
return the same promise. Recovery of a lost prepare must retain the same private
host capability and idempotency key; do not generate new launch authority for a
retry. No restart or retry scheduler is included.
For recovery across host restarts, supply and retain a private `capability` when
creating the attempt. The default generated capability exists only in memory.

The Codex adapter uses the existing isolated native home and exact trusted cwd.
It requires observed native authentication and never logs in, copies credentials,
or writes trust. Initialization can precede the native auth notification: the
adapter waits for that validated notification for at most five seconds by default.
`none` is authentication required; no notification before the deadline is
`worker_authentication_unknown`. Cancellation and process closure interrupt the
wait. No repeated initialize or authentication-file polling is performed.
The adapter configures the Provider's exact requested model and an explicit
reasoning effort (`low`, `medium`, `high`, or `max`). `default` remains unmapped and
blocks; the host does not guess a model or effort. The restricted stdio MCP gets
only the worker descriptor, never the parent's task token or session identity.
MCP startup may occur during `session/new`; business calls cannot be admitted until
the host seals its returned session ID. After configuration the host rechecks
admission before the single prompt. Worker tools recheck Provider authority on
every call. Immediate process interruption from an out-of-band Provider revoke is
not included; the host's cancellation signal interrupts the owned ACP process.
The trusted host supplies the target executable and isolated home. This port does
not invent a binding from those paths to a registered executor ID, and ACP does
not expose an authoritative actual provider/model-use field.

Completion requires `end_turn` plus a Provider-read checkpoint for the exact own
token, child session, Agent, project, application and WorkerRun turn. Only a
completed checkpoint with a `completed` or `no_change` work log produces a completed
worker event. Missing/prepared/incomplete/reported checkpoints produce
`awaiting_review`; failed work logs produce `failed`. The bounded checkpoint
summary is returned separately from prompt output. The coordinator must still
independently accept the result. Every emitted event keeps coordination task
status `running` and the reporting identity from the parent context.

ACP configuration ACKs and tool status notifications do not prove the actual
provider, executor, model, or token use. This port omits those actual-execution
fields and explicitly leaves token usage null. It does not read transcripts from
the reporting host's daily client home. Mock protocol tests are not evidence of
an authenticated model execution.

Before releasing the owned leases, the host closes WorkerRun authority, stops the
owned process, and records its terminal event. The result exposes process/run
cleanup, unrecorded activity, and lease release errors; it never turns these into
silent success. A launch failure without a returned process handle emits no
worker execution row. The host does not checkpoint or advance the parent's task.
An otherwise completed child with failed terminal reporting or lease release has
an `incomplete` host outcome. Its saved child checkpoint remains in `checkpoint`.

`graph-provider/tests/test_worker_run_host_neo4j.py` reuses the opt-in disposable
Provider/Neo4j harness and runs `acceptance/worker-run-host-live.js`. It verifies
the actual HTTP JSON contracts and persisted checkpoint/activity through the
restricted stdio MCP. Its adapter and model output are explicitly synthetic.
