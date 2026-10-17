# Session preference delivery

Task entry always reads current Provider preferences, task ownership, role and
conflicts. A delivery cache can omit unchanged instruction bodies only after a
complete model-facing native tool result has been observed in the same context
generation. Hook stdout, writing a result, a saved file and model cache hits do
not establish delivery.

The full entry keeps existing fields. Static rule references precede dynamic
task identifiers, and instruction units have a canonical order. A smaller delta
contains `preference_updates` plus `preference_delivery`: its base result ID,
base/current revision hashes, removed identities and application guidance.
Current task tokens, identity, role constraints, authority and conflicts remain
in every result. The cache never supplies permission or current business data.

Instruction fingerprints use the same mandatory projection as compact entry.
The full `read_task_preferences` result can establish that baseline while keeping
its additional source metadata; the reader itself always returns full current
preferences for its original owned task.

## Native boundaries

- Local Codex stdio accepts the host's per-request `threadId`, `sessionId` and
  optional `windowId` outside model arguments. An explicit remote host binding
  or sealed worker keeps its own admission authority. Legacy process identity
  remains a fallback, and a new MCP process establishes a full baseline.
  An ordinary MCP call without per-request window proof remains full; malformed
  host identity cannot fall back to an older process session.
- Codex evidence requires paired native call/result IDs and complete JSON.
  Code Mode must have a terminal successful result, including native logs that
  store the custom tool name as `exec`. Failed, running, truncated, unpaired or
  unknown results never acknowledge preferences.
- Claude evidence requires same-session `tool_use`/non-error `tool_result`
  pairs. Its ordinary MCP caller has no verified native identity and receives
  full entry; a trusted lifecycle adapter can inspect that chat's native file.
- SessionStart and PreCompact command definitions invalidate prior delivery.
  Compact/resume recovery reads the existing active task's full preferences,
  without creating another task or selecting another owner. Clear/startup do
  not import the previous task. Native compaction, execution/window changes,
  changed scope/rules and unavailable evidence also cause full delivery.

Metadata is private, locked across processes and contains hashes/cursors only.
It has a bounded pending set; unsupported, oversized or changed native files,
cache failures and absent instruction identity conservatively return full data.
Installing changed Hook definitions still uses the host's existing trust review.
These source changes do not install or approve daily Hook configurations.

## Verification

Protocol, lifecycle and ownership tests use explicit synthetic records. The
opt-in `graph-provider/tests/test_session_preference_native.py` uses a real
Codex client, MCP stdio, HTTP Provider and a disposable loopback Neo4j. It checks
first full delivery, a source modification/removal, same-chat delta, resume full
delivery, owned checkpoints, native model/effort and native result bodies.

Run it from `graph-provider` after supplying `FULI_TEST_NEO4J_EPHEMERAL=1`,
the disposable `FULI_TEST_NEO4J_URI`/password, `FULI_TEST_NATIVE_PREFERENCES=1`,
an authorized `FULI_TEST_NATIVE_MODEL` and, if needed, `FULI_CODEX_BIN`:

```sh
python -m pytest -q tests/test_session_preference_native.py
```

Byte counts and CLI usage are evidence for that run, not a measured billing
reduction. Claude native model acceptance is separate from its format and Hook
tests and must use an already authorized executor.
