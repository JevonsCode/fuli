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
A single complete `read_task_preferences` result can establish that baseline
while keeping its additional source metadata. Paginated results, including the
last page, never establish a whole-preference baseline on their own.

## Same-task reader pages

`read_task_preferences({ taskContextToken, cursor? })` reads current preferences
for the original owned task. Small results retain the existing `complete`
response. Larger results use `preference_delivery.status = paginated`, a full
projection `revision`, zero-based `page_index`, `page_count`, collection `totals`
and opaque `next_cursor`. Only the final page has `preferences_complete=true`.

Every page repeats the complete task token, native/worker identity, scope,
receipt and checkpoint boundary. Other top-level instruction fields (role,
application/task/judgment guidance) occur once in the page chain, as indivisible
fields. Each preference or conflict is also indivisible. Collect **all** pages
of the same revision in order before applying anything: merge the instruction
fields and concatenate `effective_preferences`, `active_conflicts` and
`deferred_conflicts`. Do not treat a final page alone as the complete set.
No instruction text, qualifier, authority or conflict alternative is shortened.

The implementation budget is 32 KiB for UTF-8 `JSON.stringify` of the complete
MCP envelope, including both identical content and structured channels. This
is a conservative implementation contract, not a documented universal Codex
token/display limit. Every page is preflighted before the first is returned.
A single instruction field/item plus required identity that cannot fit blocks
the whole delivery without returning preference fragments. Source-window or
unsafe-projection failures also stay blocked.

Cursors bind the token and complete current projection (all instruction,
identity and scope fields). Every continuation reauthorizes and rereads the
Provider before checking its cursor. Snapshot changes, permission revocation,
cross-token/session/scope use, unknown or expired cursors reject. Cursor metadata
is private to the application process, contains no preference bodies, expires
after 15 minutes, and retains at most 128 snapshots. Retries within that lifetime
return identical pages. After restart, eviction, expiry or snapshot rejection,
discard the old chain and call this reader without a cursor using the **same**
task token. Never restart task entry to recover. Older clients that do not
support continuation see incomplete delivery and must stop; small-result
compatibility remains unchanged.

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
  unknown results never acknowledge preferences. A command hook's context is
  model-facing when the rollout records it as a `developer` message with one
  `input_text` part, kind `hooks.additional_context` and harness command-hook
  provenance (openai/codex `d6817454`); it has no result ID, so it confirms
  recent context but is never a preference delta base.
- Claude evidence requires same-session `tool_use`/non-error `tool_result`
  pairs. Its MCP process can use the host's own UUID `CLAUDE_CODE_SESSION_ID`
  for same-task recovery; a caller without verified provenance cannot invent
  that identity. A trusted lifecycle adapter can inspect that chat's native file.
- SessionStart and PreCompact command definitions invalidate prior delivery.
  Compact/resume recovery reads the existing active task's full preferences,
  without creating another task or selecting another owner. Clear/startup do
  not import the previous task. Native compaction, execution/window changes,
  changed scope/rules and unavailable evidence also cause full delivery.

## Recent conversation context

The Provider packs a bound conversation's recent window within its budget, as
before. When a session's entry asks for it, the Provider also attaches host-only
proofs to each message: the SHA-256 of the whole content and, for that same
client and native session's own records, the native event ID. The host removes
them before anything is delivered.

At delivery the host leaves out a message only when this session's current
context generation provably holds that exact version:

- its own native message: the event ID names a complete record at or after the
  generation start in the session's own transcript, and that record's same
  event (role, kind, content chunk) hashes to the stored content;
- or a message in an earlier frame that the host recorded completely in a
  model-facing record of this session (Claude's UserPromptSubmit hook
  attachment or a FULI tool result; Codex's command-hook developer message or
  a FULI tool result), matched by the whole recovery block and task token as
  the model saw them (a tool result's visible text, never its structured copy)
  and the pending hash. Pasted text, quotes, nested JSON, Hook stdout, a preview
  of an oversized context and model claims never count.

A cache record this FULI cannot trust (a newer version, corrupt or oversized)
may have held a reset's boundary, so it is never read as a fresh session: the
generation then starts at the transcript's current end, or, without a
readable transcript, is unknown and nothing is left out or saved. A reset
(SessionStart, PreCompact, FULI switch) that cannot read the transcript, or
finds its last record unfinished, saves the boundary as unknown in the same
way, never as the file's start.

The cache records, per delivered frame, its conversation, hash and explicit
`[sequence, content hash]` pairs, never a maximum sequence. A truncated prefix
is never recorded. At most eight frames of 32 pairs are kept; losing one only
causes a resend. A message that left the window, or one cut to a prefix by a
smaller budget, is not withdrawn. Only a confirmed version that the Provider
now returns with different content at the same sequence is named in
`recovery.withdrawn`, and that frame is resent until it is confirmed; a
confirmed withdrawal takes that version out of what the session holds, so a
version that comes back is delivered again. The
Provider currently has no delete marker for conversation events and never
replaces one in place, so this path is defensive.

Compaction, clear, resume, fork, a new MCP process, an execution/window change
or a replaced transcript starts a new generation, which receives the window in
full. So does a client without a readable transcript. A failed, truncated or
unrecorded delivery is resent.

A session with no bound conversation gets `conversation.recent_conversation`:
the ID, `updated_at` and a one-line title (at most 96 bytes as serialized JSON)
of the latest conversation in the same space, project and Agent, read with the
same client permission and only while recording is on. The whole serialized
`recent_conversation` field is at most 320 bytes (179 in the synthetic test with
a full title); one that would be larger is left out, never cut. It binds nothing
and reads no messages; continuing is still an explicit `resume_agent_conversation`.

Known limit: the result of `resume_agent_conversation` is not tracked as a
frame, so the next entry of the resuming session sends the resumed messages
once more before they count as seen.

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
