# Session preference delivery

Task entry always reads current Provider preferences, task ownership, role and
conflicts. A delivery cache can omit unchanged instruction bodies only after a
complete model-facing native tool result has been observed in the same context
generation. Hook stdout, writing a result, a saved file and model cache hits do
not establish delivery.

The full entry keeps existing fields. The task token, checkpoint requirement
and receipt come first, so a host that keeps only a preview of a long entry
still shows how to close the task (rec#47 F1); static rule references follow,
and instruction units have a canonical order. A complete
frame with at least one preference, in a session whose generation can be read,
adds one field, `"revision":"<12 hex>"` (26 bytes): the first 12 hex digits of
its snapshot hash, so a later frame can name it (rec#15 D-29.3). An empty set,
or a session that can never confirm a frame, gets exactly the uncached result.
A delta contains `preference_updates` plus `preference_delivery`: `base_revision`,
its own `revision`, removed identities and the rule reference. A delta or scene
switch is sent only when it is smaller than the uncached complete frame;
otherwise the complete frame is. Current task tokens, identity, role
constraints, authority and conflicts remain in every result. The cache never
supplies permission or current business data.

The model locates a base by exact revision within the same context
generation. Several frames may show one revision (an unchanged delta repeats
its base's): FULI shows a revision only for one set, so they are one base. With
no such frame, or two that yield different sets, the model rereads with
`read_task_preferences` and never guesses. The host keeps the whole snapshot
and frame hashes privately and verifies against them. It also tracks every
revision the generation shows: one shown by two different sets, or by a frame
it cannot verify, names no base, so the next frame is complete and takes a
longer revision (16, 20, … hex) that no other frame shows; if every length is
taken, the frame is complete without one (D-29.9). A tool result whose visible
text differs from its structured copy confirms nothing, but the revision its
visible text shows counts as taken.

A task in another scene of the same space, project, Agent, client and session
(its persisted `preference_scope` changed) gets a `scene_switch` result when an
acknowledged base exists and the switch is smaller (rec#15 D-27.8). It lists
only the scene-personalized set, names the base by `supersedes`, the new scene
by a short `scene` (such as `"frontend"`) and the base keys it takes over in
`replaces`; boundaries and hard constraints are not listed and stay in force.
If a boundary changed too, or no base is acknowledged, the result is complete.
A complete frame never declares its scene. The pending record the producer
keeps for a frame stores the scene beside its scope, snapshot and whole-frame
hashes (D-29.2); confirmation rebuilds the frame in that scene, so a copy that
claims another scene never matches. A pending item written before this, without
a scene, confirms nothing: that frame is sent in full again. Like any frame, a
delivered scene switch also confirms the recent-context messages it carries.

Instruction fingerprints use the same mandatory projection as compact entry.
A single complete `read_task_preferences` result can establish that baseline
while keeping its additional source metadata. Paginated results, including the
last page, never establish a whole-preference baseline on their own.

## Inline budget (Claude Code)

Claude Code shows the model only a preview, about the first 10,000
characters, of a hook context longer than that and saves the rest as a file
(rec#47 F1b). The preferences past the preview are never seen, and a preview
is no frame, so nothing is confirmed and every turn resends the whole entry.
Its adapter therefore bounds the UserPromptSubmit task entry to 9,000
characters, label included (`CLAUDE_ENTRY_INLINE_CHARS`, rec#11 D-54); the
rest of the 10,000 leaves room for an appended notice. The mechanism is
`src/conversations/entry-inline-budget.js`. Every other Agent, every entry
that fits, and the full-frame SessionStart restore and in-place refresh are
unchanged, byte for byte. Known limit: those two still send their whole
frame, so one longer than the preview is not confirmed.

An entry over the budget is reduced in this order, each step only while the
frame this session would get (a delta where one applies) is still too long.
A frame blocked for `delivery_budget` (the whole result past its 128 KiB
budget) is short but delivers nothing, so it counts as too long; every other
blocked reason (`source_window`, `unsafe_projection`) is about the data and is
delivered as blocked.

1. `task_knowledge_recall` keeps its status and counts and becomes a pointer
   (`items_omitted`, `read: { tool: 'search_current_project_knowledge' }`);
   a coding task's title-only `knowledge_index` (rec#51 D-59) is part of the
   recall, so it goes the same way and its pairs count as `items_omitted`.
   Like the recall it is per task and outside the preference frame: no
   revision, snapshot or delta covers it;
   then the recent conversation window drops its oldest messages, marked as
   the Provider marks its own window (`truncated`, the latest
   `omitted_sequence`; `read_agent_conversation` reads it whole).
2. Then preferences go. Closing fields, identity, role, authority, conflicts
   and every field outside `effective_preferences` always stay, and so do hard
   rules. The rest rank by kind and task scene, using the scene table in
   `task-scene.js`: a boundary first (an item a scene switch never revokes,
   `preferenceSceneReplaceable` false), then an item whose own scene key names
   the task's work kind (`preferenceNamesWorkKind`), then human-confirmed
   before agent-confirmed, then the Provider's order. The delivered set is the
   largest ranked prefix whose *complete* frame fits with the leanest context,
   so it depends on the preferences alone, not on the conversation or the
   cached base: the same preferences select the same set next turn.
3. Then as much recall and conversation as still fits comes back.

What always stays (`preferenceAlwaysInline` in
`src/graphiti/preference-task-scope.js`, rec#11 D-69) is a rule a person
marked `constraint: "hard"`, in any aspect. FULI has no separate boundary
marker: a boundary is the scene table's default for a `judgment_preference`
without a scene key and without `constraint: "soft"`, which keeps it out of a
scene switch's replaceable set but says nothing about it never being left out.
Before D-69 every such item always stayed, and in rec#47 26 of 31 preferences
did, more than the preview alone; now a boundary ranks first among the rest.

What is left out is named as `preferences_omitted: { count, read: { tool:
'read_task_preferences', arguments: { taskContextToken } } }`, and the label
adds one sentence: read them before acting where one may apply. If the hard
rules alone are longer than the budget (D-69, revising D-54), they are bounded
the same way: the largest prefix in the Provider's order whose complete frame
fits, with nothing ranked after them. Past Claude Code's preview a hard rule
was never seen anyway, and the preview confirmed nothing; now the omission is
explicit. `preferences_omitted` then also says `includes_always_inline: true`,
and the label adds a second sentence: hard rules are among them, read them all
with `read_task_preferences` before acting; they stay in force.

A bounded entry is still a complete, confirmable frame:

- Its revision and the producer's pending snapshot hash cover exactly the set
  it lists. An omitted preference is in no snapshot, base or cache, and is
  never counted as delivered. A revision therefore still names one set: a
  frame that lists S and leaves N out, and one that lists S alone, hold the
  same set S. `preferences_omitted` belongs to the frame, not to the set: the
  whole-frame hash binds it, every frame (a delta included) carries its own,
  and it describes only that frame.
- A bounded frame never names a removal and is never a scene switch: an item
  it leaves out may still be in force, so `removed` or `replaces` would read
  as revoked. Such a turn gets the complete bounded frame instead. A delta
  that only adds or changes is allowed, so the next turn with the same
  selection is a small delta on the confirmed bounded frame.
- The entry is tried whole first: a delta on a whole base (such as a complete
  `read_task_preferences` result the model read) that fits is sent with
  nothing left out.
- No stored format changes: a pending item keeps its scope, snapshot, frame
  hash and scene.

## Coding-task knowledge index

A task prompt that matches no recall intent gets `task_knowledge_recall`
`not_needed`. When it is a change request in a resolved project, the entry
first makes one search of the prompt's distinctive terms (rec#51 D-59), read
as the recall reads: no FLA reader, no preferences, confirmed first, and a
sensitive prompt is suppressed before any search. Only items the exact
project defines (not inherited or global) and that name one of those terms
count. With one, the recall is `status: "indexed"` with a `knowledge_index`:
at most five `[id, title]` pairs (titles cut at 40 bytes), `matched_in_search`
and one line to read an item with `search_current_project_knowledge` before
relying on it. No body and no source marker.

- `matched_in_search` counts what that one bounded search returned and kept
  (the Provider caps each kind at 12; pending items drop out when a confirmed
  one matched). It is not the project's total.
- "Change request" is a heuristic, not intent classification: a clause that
  opens with an imperative change verb, after at most a few polite or
  sequencing words (`please`, `can you`, `then`, 请, 帮我, a 把/给 phrase). A
  clause that asks (a question word, a trailing `?`, 吗 or 呢, unless it is a
  "can you" request), opens with a negation, or uses the word as a noun
  ("tests for") never counts.
- 2 s is a threshold for *starting* the search, not a timeout of its own:
  with less of the hook's entry time left the entry goes without it, as it
  goes without a model hint. A search already running is cut short like every
  other entry read: the hook's abort signal reaches the Provider request,
  which combines it with its own request timeout (`AbortSignal.any`), and a
  failed search leaves the recall `not_needed`.
- No match, no resolved project, a failed or skipped search: the recall is
  the `not_needed` one, byte for byte.

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
  provenance (openai/codex `d6817454`). It has no result ID; like any complete
  recorded frame at or after the generation start it confirms recent context
  and, by its revision, can be a preference base (rec#15 D-29.3). An older
  rollout without that provenance proves nothing, so Codex then resends in full.
- Claude evidence requires same-session `tool_use`/non-error `tool_result`
  pairs, or a UserPromptSubmit hook attachment whose rendered text holds a
  whole frame; the task entry is bounded so that it does (inline budget above). Its MCP process can use the host's own UUID `CLAUDE_CODE_SESSION_ID`
  for same-task recovery; a caller without verified provenance cannot invent
  that identity. A trusted lifecycle adapter can inspect that chat's native file.
- SessionStart and PreCompact command definitions invalidate prior delivery.
  Compact/resume recovery reads the existing active task's full preferences,
  without creating another task or selecting another owner. Clear/startup do
  not import the previous task. Native compaction, execution/window changes,
  changed scope/rules and unavailable evidence also cause full delivery.
- Except a Claude Code resume (rec#11 D-69, rec#47): Claude Code resumes a
  session (`--resume`, `/resume`, and every `claude -p --resume <id>` process)
  by replaying the same transcript into the model's context, so the frames
  delivered before are still seen. Its `SessionStart` with `source: "resume"`
  keeps the delivery state (pending frames and the generation start) and
  restores nothing; the next entry is a delta on the replayed frame. The
  Claude adapter passes this as `replayedSources: ['resume']` to the shared
  `preferenceLifecycleOutput`; Codex passes none, so its resume is unchanged.
  A compaction Claude records in that transcript still starts a new
  generation.

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

Compaction, clear, resume (except Claude Code's, which replays the same
transcript, see above), fork, a new MCP process, an execution/window change
or a replaced transcript starts a new generation, which receives the window in
full. So does a client without a readable transcript. A failed, truncated or
unrecorded delivery is resent. A transcript is identified by its exact device
and file ID (BigInt): a Windows file ID above 2^53 would round as a Number, and
a replacement with the neighbouring ID would read as the same file. A cache
record written with a rounded ID reads as a replaced file once, so that
session's next entry is complete.

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

Protocol, lifecycle and ownership tests use explicit synthetic records.
`npm run measure:context-delivery` replays the scenarios through the real hook
entries with two synthetic fixtures, `tiny` and the fixed-seed `scaled` one
(6–10 preferences of 120–400 B, 8–12 messages of 120–1500 B), and prints one
table per fixture, with the uncached skeleton as a separate diagnostic. Both
fixtures get the Provider's own recovery window (back to the third user
message, packed into the default 4000-byte `context_budget`), so the uncached
baseline holds only what the Provider would return.
`test/context-delivery-replay.test.js` holds the gates on these fixed fixtures:
no turn costs more than the uncached entry except a complete frame's revision
field (26 B) and a `recovery.withdrawn` block (128 B), no scenario costs more in
total, the scaled scenarios that reuse context cost less, no turn needs a reread
under the delivery rules, and every model view is whole.
`test/agents/claude-code/entry-inline-budget.test.js` checks the inline
budget with a synthetic 60-preference entry: it fits, keeps every hard rule,
closing field and conflict, ranks boundaries first, counts what it leaves out,
is confirmed from its Claude transcript record and is followed by a delta; an
omitted preference is never delivered, a bounded frame never removes one still
in force, and hard rules alone over the budget are bounded too, with
`includes_always_inline`. `test/agents/claude-code/resume-delta.test.js`
reproduces rec#47 (D-69): the second turn is a delta after a `SessionStart`
resume between turns, with 26 hard rules and 5 general items, and with 26
unmarked judgment boundaries. The
token-budget test records its two-turn size. The
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
