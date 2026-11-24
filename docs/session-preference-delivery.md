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

A frame produced but not recorded yet is still a base for exactly the same set
(design T1). The host writes a hook's context only after the hook returns, so
two prompts a few seconds apart (queued host notifications, input appended to a
running Codex turn) used to resend the same delta. The pending item keeps
`producedAt`, the transcript's length when the frame was produced. While no
model output (a Claude assistant record, a Codex assistant message or tool
call) follows that point and the frame is not written anywhere in the
generation, the next frame with the same snapshot is an empty delta on it,
named by the revision it showed. Once the model has answered after it and it is
still missing, or it was written on a branch a rewind left behind, it was lost:
it is no base, and the next frame builds on what the transcript records, or is
complete. Any changed set still needs a recorded base. One window is left: a
frame is lost and, before the model answers, another prompt's hook runs (a
queued prompt). That one cannot tell a lost frame from one still on its way, so
it is built on the lost one (an empty delta, or one line for a host event), and
two turns in a row lack the context; a delta whose base the model cannot find
tells it to read the preferences. The turn after that cannot verify the base in
the transcript and gets the whole context again
(`host-event-turns.test.js`). A session that ends inside the window is not
given it again.

A complete frame sent in place of a delta replaces the set of the frames
before it, but the bodies they showed are still in the conversation, and a
complete frame carries no rule reference saying so (the reference rides only
on a delta or scene switch). So it names each preference of its base that the
whole entry no longer has, by key and layer as the index names them
(`"rule-3"`, `"rule-3 (project)"`), in a field whose name says what that
means: `preferences_removed` for one deleted or disabled, and
`preferences_out_of_scene` for a scene item of a base in another scene, which
applies again once a later frame lists it. One it only leaves out under an
inline budget is still in force and is not named. Each field is there only
when it has a name: 25 and 30 bytes plus each name quoted (34 and 39 bytes
for one key like `rule-12`), nothing otherwise
(`session-preference-delta.test.js`).

A turn may be handed to another FLA within one session (a workstream's owner,
#1063). The authority differs, so that frame is complete and chooses afresh,
also when the session goes back to an FLA it had before (A, B, then A again):
each pending record keeps its `authorityHash`, and where the latest frame was
another authority's, nothing is held and no delta is built on the older frame
of this one. `authorityHash` is the snapshot's authority, which includes the
entry rules' version, as its `scopeHash` does: two processes on different
rule versions taking turns on one session read each other's frames as another
authority, but they could not verify them as a base either (the scope hash
differs), so each such turn is complete already and nothing changes. The
FLA-level preferences the frames since then spelled out are
still in the conversation, so that frame names each one this FLA does not
have, by key and layer, in `preferences_of_previous_agent`: they do not apply
to this FLA. Only when it has a name: 35 bytes plus each name quoted (52 bytes
for one name like `rule-12 (agent)`), nothing otherwise
(`entry-inline-budget.test.js`).

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
`src/conversations/entry-inline-budget.js`. The SessionStart restore after a
compaction and the in-place refresh of a host turn that gets the whole context
(Host turns below) are bounded the same way, from what `read_task_preferences`
returns. Every other Agent
and every entry that fits are unchanged, byte for byte.

An entry over the budget is reduced in this order, each step only while the
frame this session would get (a delta where one applies) is still too long.
A frame blocked for `delivery_budget` (the whole result past its 128 KiB
budget) is short but delivers nothing, so it counts as too long; every other
blocked reason (`source_window`, `unsafe_projection`) is about the data and is
delivered as blocked. A blocked frame keeps its `taskContextToken`, and
`preference_delivery.token_use` names what it is for:
`read_task_preferences` and `checkpoint_task_knowledge`. Reads and searches may
carry it (the session gate needs it), but no roundtable, team or write call
until the preferences are complete (rec#110 item 6).

1. `task_knowledge_recall` keeps its status and counts and becomes a pointer
   (`items_omitted`, `read: { tool: 'search_current_project_knowledge' }`);
   a coding task's title-only `knowledge_index` (rec#51 D-59) is part of the
   recall, so it goes the same way and its pairs count as `items_omitted`.
   Like the recall it is per task and outside the preference frame: no
   revision, snapshot or delta covers it;
   then the recent conversation window drops its oldest messages, marked as
   the Provider marks its own window (`truncated`, the latest
   `omitted_sequence`; `read_agent_conversation` reads it whole).
2. Then preferences go. They always get at least half the limit
   (`PREFERENCE_SHARE`, design T3), measured as the JSON of what they deliver:
   every hard rule, the index of the rest and the largest ranked prefix that
   fit in it, chosen as below. That half is a floor, not a cap. The recall and
   the conversation give way down to it; the room they leave goes to more
   preferences, until the complete frame no longer fits. A preference named
   only by its key cannot be judged to apply, so a body the limit can hold is
   never left out to keep room free (with the half as a cap, the synthetic
   60-preference entry listed 6 bodies and the keys of 54 others in 6,299
   characters; it lists 10 and the keys of 50 in 8,693, as before T3). The
   generation's first frame chooses the set as main does: the bodies past the
   floor are counted beside the leanest context first, and the recall and the
   conversation then take the richest level that fits beside them, so a first
   frame never spells out fewer than main's (taking the recall first left a
   real-scale first frame 4 bodies short of main's 17).
   A later frame of the generation in the same scope never lists fewer than
   its base frame (the acknowledged base, `held`): dropping a body would make
   the frame complete again (a bounded frame never names a removal), while
   adding one only sends its body once in the delta. So the base's bodies and
   the floor take the richest level where the frame this turn actually
   delivers fits, and then the rest are added in rank order while that frame
   (most often a delta, which does not repeat a body the model holds) still
   fits, up to a cap: what a first frame would list beside the leanest
   context, by rank (what main lists on its lightest turn), counting only the
   preferences that were there before, plus the ones the person added since,
   within a quota: the person just set them, and main would give them a body
   on the next turn, so they never wait for room in a session already at its
   cap. The quota is for the few a person just said, not for an import: a
   generation spells out at most the cap again that way (or what its base
   spelled out of its own, where that is more; at least 3, at most 64),
   best-ranked first, each only where fewer than the cap of the older ones
   rank above it and its body fits beside the leanest context at all. One
   past the quota ranks like any other and is only named past the cap, as on
   main, even where it would rank into the preferences' floor (the first
   frame's floor is in the base already; an import that outranks everything
   would otherwise take the floor batch by batch). Fifty added at once, or
   ten (or four) in each of several turns, spell out no more than that. The
   quota bounds an import, not a person talking: whatever is left of it, the
   new ones a frame sees for the first time (neither owed nor in view before)
   get room for at least 3 of them (4 said at once: 3 in full, not all only
   counted), and count as spent. They take that room before the owed ones,
   which use only what is left of the quota itself.
   "In view" is told by the frame's index, or, where a frame only counts what
   it leaves out, by `known`: short hashes of what the scope's first frame
   had, plus each new one a frame left to rank, kept once for the latest
   scope (at most 1,024: a first frame past that keeps 1,024 of its set, and a
   later frame that would pass it adds none, so what was in view is never
   forgotten whole). Missing one the
   person must follow is worse than sending one more, so the recall gives way
   to the added ones: the level is the richest where the base's bodies and
   every added body fit; where none does, the leanest, with the added ones by
   rank as far as they fit there. "Added" is told against the generation and
   scope, not the frame before: one within the quota that a frame named only
   in its index, because it did not fit or because a frame before was still on
   its way, stays added until a frame spells it out. Each pending record keeps
   those it owes (`owed`, a 16-hex hash of key and layer each) and the quota
   the generation has spent (`spent`); a record written without them owes
   none and has spent none, since only a FULI that holds a set across frames
   ever leaves a new one out of a frame it builds on. Neither can pass 64; a
   value past it, or malformed, makes the record untrusted, and the session
   starts a new generation with complete frames. While processes of an older
   FULI and this one take turns on one session (an upgrade with a client still
   running the older one), a frame the older one produced carries neither
   `owed` nor `spent` nor `authorityHash` (below): built on it, an owed
   preference ranks like any other and a hand-over to another FLA is not
   recognised, which is what the older FULI does on its own, never fewer
   bodies than that. One
   ranked past the cap is only
   named, as on main. Hard rules are never counted. A turn with a lighter recall therefore catches up on bodies a
   richer first frame could only name, and none is ever taken back while it
   fits; past the cap nothing more is spelled out, so the bodies of every
   preference are not sent one turn after another (which preferences deserve
   a body beyond that is for ranking by when they apply to decide). The
   synthetic 60-preference entry lists 10 bodies, already its cap, and its
   next turn is the 1,403-character empty delta, as on main; a first frame
   beside a rich recall lists what main does there, 9, as the recall gives
   way, and a lighter turn adds none past it. Before the held set, the preferences
   took whatever the rest left, so a longer recall or one more guidance
   sentence listed fewer of them and most prompts of a session were whole
   frames; while the set was held whole, a generation whose first frame came
   beside a rich recall stayed near the floor for good. Whether a preference
   is one the base indexed is told by its key and layer where the index has a
   line (`key (project) — …`); a keys-only index names the key alone and
   cannot tell two layers apart. While a frame produced earlier is still on
   its way (below), a frame adds nothing: it builds on the recorded base, so a
   lost frame that added bodies is never named as a base; a preference added
   meanwhile is owed and spelled out by the next turn. In another scope
   (another project or work kind; the snapshot's `scopeHash` differs) the
   frame is complete anyway, so nothing is held: it chooses afresh, as a
   generation's first frame does. Where the keys of the rest do not fit
   beside the hard rules in half the limit, the floor counts the rest instead
   of naming them (the whole frame still names them where it has the room, as
   the search below would). A working set shaped like a real one (70
   preferences, 8 hard rules, Chinese bodies of about 170 characters, keys of
   30 to 45 characters) needs about 5.9k characters for the hard rules and the
   keys, past the 4.5k share: before, it had no floor, and no frame of such a
   session held its set. Measured (`a real-scale working set keeps its floor`,
   entry-inline-budget.test.js): the first prompt is complete, 8,823
   characters, 17 in full (main's search on the same entry: 17); five host
   events one 171-character line each; a prompt with a rich recall a
   5,300-character delta, 17 in full; one with a habit added a
   3,341-character delta, 18 in full, the added one among them; the next a
   3,115-character delta, 18 in full. A later frame never upgrades the
   floor's index to the keys alone because a delta leaves room: the room is
   there only because held bodies are not repeated, and keys alone (some
   2.2k characters here, sent once) give the model nothing to judge by; it
   takes the lines where they fit, and otherwise keeps the floor's tier. Only where the hard rules alone exceed half the limit is there no
   floor, and then nothing is held: the search below chooses each frame
   afresh, as main does, so such a frame may list fewer than its base and is
   then complete, and it says so in `preferences_not_held` ("hard rules fill
   half the inline limit", 63 bytes with its key), so that holding is never
   switched off unnoticed. Holding is built on the floor's room; without it a later frame
   could not keep its base and still fit the hard rules, which come first.
   Only where the base's bodies do not fit
   (a body grew, or this turn must be complete, such as one whose base listed
   a preference that was since deleted) do they give way, as a complete frame
   beside the leanest context: a preference changed since the base first, so
   the model is not left holding its old body and a line, then the base's
   bodies, the floor and new ones by rank, then the rest; hard rules always
   stay. That turn gets the complete frame, which says
   what it now leaves out. Where the floor does not apply (the hard rules and
   an index exceed it, or the details do not fit beside it), the search below
   decides. Closing fields, identity, role, authority, conflicts
   and every field outside `effective_preferences` always stay, and so do hard
   rules. The rest rank by kind and task scene, using the scene table in
   `task-scene.js`: a boundary first (an item a scene switch never revokes,
   `preferenceSceneReplaceable` false), then an item whose own scene key names
   the task's work kind (`preferenceNamesWorkKind`), then human-confirmed
   before agent-confirmed, then the Provider's order. In that search the
   delivered set is the largest ranked prefix whose *complete* frame fits with
   the leanest context, so it depends on the preferences alone.
3. Then as much recall and conversation as still fits comes back.

What is left out last (`preferenceAlwaysInline` in
`src/graphiti/preference-task-scope.js`, rec#11 D-69) is a rule a person
marked `constraint: "hard"`, in any aspect. FULI has no separate boundary
marker: a boundary is the scene table's default for a `judgment_preference`
without a scene key and without `constraint: "soft"`, which keeps it out of a
scene switch's replaceable set but says nothing about it never being left out.
Before D-69 every such item always stayed, and in rec#47 26 of 31 preferences
did, more than the preview alone; now a boundary ranks first among the rest.

What is left out is named as `preferences_omitted: { count, index?, read: {
tool: 'read_task_preferences', arguments: { taskContextToken }, call } }`, and
the label adds one sentence: read them before acting where one may apply.
`index` names every left-out preference, one short string each —
`key — what it says`, plus `· 仅适用于 X` where the instruction states its own
scope in prose (rec#137, rec#111). Before it, the only way to learn what
existed was to page a whole revision at the 32 KiB MCP budget, which a task
entry's own token rotation made impractical. The index is built after the hard
rules and the three best-ranked preferences are in, so it never costs one of
them its full body; where even then it does not fit, it falls back to the keys
alone, and past that to the count. `read.call` is the short formula
`fuli_call(toolName=tool, input=arguments)`: `read_task_preferences` is not a
listed tool in the chat profile, and `fuli_call` takes the tool's arguments
under `input` while `list_agent_interfaces` shows them at the top level, so
following the schema alone failed validation on the first call. A
single-tool `list_agent_interfaces` answer now carries `call`, the exact
`fuli_call` envelope with each required argument as a `<placeholder>`.
The label tells the model to read what may apply by key (`keys` below).
A delta whose index is word for word the one its base frame showed does not
resend it: `preferences_omitted` says `index_unchanged: true` instead, and the
session rebuilds the index the model holds from the recorded frames (the
base's own, or its base's through further `index_unchanged` deltas). Any
change to what is left out sends the index again. Measured on the synthetic
60-preference entry: the second turn is 1,403 chars (main: 1,329; with the
index resent: 1,883). If the hard
rules alone are longer than the budget (D-69, revising D-54), they are bounded
the same way: the largest prefix whose complete frame fits, with nothing
ranked after them. That prefix keeps the most specific rules first (Agent,
then project, then global scope, each in the Provider's order): a more
specific rule overrides a broader one, so it is the one the model can least
infer. Past Claude Code's preview a hard rule was never seen anyway, and the
preview confirmed nothing; now the omission is explicit. `preferences_omitted`
then also says `includes_always_inline: true`, and the label adds a second
sentence: if they are not already in this conversation, read the omitted ones
once with `read_task_preferences` before acting; they stay in force. A delta
repeats the label every turn, so it asks for one read, not one per turn.

An entry whose rest does not fit even with every detail reduced (a role
longer than the budget: the role is never cut) is the blocked frame
(`inline_budget`). It used to list no preference at all (rec#128). It now
lists the largest prefix of the same ranking that fits beside the token,
closing fields and identity (hard rules first, most specific scope first,
then the ranked rest), with `preferences_omitted` counting the rest and, where
it fits beside them, naming each of them in the same index. Its
lead, above the frame and in its guidance, says to apply them while
recovering the rest and not to finish the task on them alone. Every blocked
frame counts the active conflicts it leaves out as `active_conflicts_omitted`.
A blocked frame is never a delta base.

Every read an entry names is one the reader can serve (rec#128).
`read_task_preferences` replays the task Agent, so an entry without a task
token or task Agent names no `read` in `preferences_omitted` or
`active_conflicts_omitted`; its label then says the task cannot read them and
to ask the person before acting where one may apply. A blocked entry frame
says `same_task_recovery_available` from the same rule: `true` with
`token_use: ["read_task_preferences", "checkpoint_task_knowledge"]` and the
recovery guidance, or `false` with `token_use: ["checkpoint_task_knowledge"]`
and guidance that does not mention the reader. A blocked result of the
reader itself (one instruction past its page budget, a source window, an
unsafe projection) is always `false`: reading again cannot recover it.

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
- A pending item keeps its scope, snapshot, frame hash and scene, and since
  design T1 an optional `producedAt`. The record stays version 4: it is a
  private cache of this computer only, a FULI that predates the field ignores
  it and never takes the frame as a provisional base (it can only send more,
  never less), and this FULI reads a record without it as having no
  provisional base.

### The session record, version 4

The record (`preference-session.js`, one file per host session, at most 64
KiB) is a private cache of hashes; it never holds an instruction. A field
that is missing reads as below. A field that is malformed or past its limit
makes the whole record untrusted: the session starts a new generation with
complete frames, so a bad record only ever sends more, never less.

| Field | What it is | Limit | Missing |
| --- | --- | --- | --- |
| `version` | 1 to 4; written as 4 | — | untrusted |
| `floor` | transcript offset where this generation starts; `null` unknown | integer | the file's start |
| `fileId`, `generation`, `nativeGeneration` | which transcript and host window the generation belongs to | — | no change detected from them |
| `pending[]` | frames produced: `scopeHash`, `snapshotHash`, `frameHash` (64 hex), `scene` | 16 items | untrusted (`pending` itself) |
| `pending[].producedAt` | transcript length when produced; the frame is on its way until the model answers after it (T1) | integer ≥ 0 | never a provisional base |
| `pending[].authorityHash` | whose task the frame was (64 hex); another FLA's turn is complete (#1063) | — | no hand-over named |
| `pending[].owed` | 16-hex hashes (key and layer) of the added preferences within the quota the frame did not spell out yet | 64 | owes none |
| `pending[].spent` | how much of the generation's added-preference quota is spent | 0 to 64 | none spent |
| `recent` | recent-conversation frames sent (`recent-context.js`) | 8 | none |
| `tasks` | [token, owner] hashes of tasks a hook delivered (skeleton bases); version 3 `prompts` read as these | 16 | none |
| `known` | `{ scope, ids }`: 16-hex hashes of what the latest scope already had in view (its first frame's set, plus new ones a frame left to rank) | 1,024 ids | every unnamed preference is new, within the quota |

`producedAt`, `authorityHash`, `owed`, `spent` and `known` came with the held
set (design T1 and T3) without a new version: a version-4 FULI that predates
them ignores them and can only send more.

## Host turns (design T1)

Each Agent's adapter names where a prompt turn came from (`turnOrigin`):
`person`, `host_event` or `host_system`. The host's own mark decides where the
hook input carries one: `isMeta` or `is_meta` true is `host_system`, false is
the person's. Only an input without the mark is read by its shape: in Claude
Code a prompt that is exactly one `<task-notification>` or
`<ci-monitor-event>` envelope is `host_event`; any text around it makes it the
person's. Codex reads only the mark. An Agent that cannot tell takes every turn
as the person's. The shared layer reads only that value
(`refreshCurrentTaskInPlace` in `src/conversations/unresolved-turns.js`). A
host turn never begins or switches a task. When this context generation has
already given the session a frame (recorded, or provisional as above), it gets
one line saying the turn is not the person's, that the current task and the
context already given still apply, and that no `get_collaboration_preferences`
call is needed (the MCP instructions otherwise tell a model whose hook gave no
context to make one): no preference read, scope check, budget fit, delta or
pending record, and no `checkpoint_required`. One session of 155
notifications had been given 123k characters this way. Only a generation that
has given nothing (a compaction whose restore failed, an unreadable record, a
lost frame, no delivery at all) re-reads the current task in place and gets it
whole: a missed preference costs more than a resent one.

A preference changed in the middle of a run of notifications reaches the model
at the person's next prompt, though the model may act during those
notifications (fix a failed build, push). Telling a change apart without the
Provider would need a local mark of the preference set's revision, and there is
none: the preferences live in the Provider, and finding out whether they
changed is the same read the line saves. So the line stays one line.

Known misreadings, and what they cost:

- A person who pastes a whole notification envelope into Claude Code with no
  other text, or a hook input the host marks `isMeta` for a person's message
  (a slash command or Skill expansion, a wrapper that passes the mark on), is
  taken as a host turn. That turn begins no task, gets no recall and no
  checkpoint, and gets no preference change made since the last frame; the
  preferences already in the conversation stay in force.
- Cursor and OpenCode give no such signal, so every turn of theirs is the
  person's, as before.

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

`read_task_preferences({ taskContextToken, keys? , cursor? })` reads current
preferences for the original owned task. With `keys` (up to 20, the keys an
entry's `preferences_omitted.index` names) it returns those preferences whole
in one result, with no page and no cursor, and names any key the task does not
have in `preference_delivery.missing` (status `keys`, rec#137). A key held by
an unresolved conflict is named in `in_conflict` instead (apply no alternative
until it is resolved), and one limited to a scope this task does not state in
`scope_unknown`. Keys whose bodies do not fit one result together are refused
with "read them with fewer keys at a time", never as a blocked recovery. It is never the
complete set (`preferences_complete: false`), so no session takes it as a
delta base. Without `keys` it reads the whole set, paged at the MCP budget.
Its cursors are process-local and live 15 minutes, and every task entry issues
a new token, so a whole-set read begun in one turn cannot be resumed in the
next: start it again with the current token. Reading by key is what the index
is for, and avoids that. The session it reads for is never the caller's:
a host that names a session (Codex's thread, Claude Code's
`CLAUDE_CODE_SESSION_ID`, a sealed worker) binds it, and a token of another
session is refused; a process started before `/clear` or an in-app resume
still names the earlier session, and the reader refuses it as such (tell the
person, checkpoint as incomplete). A process of a client that names no
sessions at all (Cursor and the other clients without a session reader in
`agents/native-session-env.js`, and Claude Desktop's connector, `claude`,
also when it serves its Code tab, rec#107) reads the session of the task the
token names while that is its client's current, unfinished task (rec#128).
So two windows of such a client can read each other's current task
preferences given the token, as they can already checkpoint with it. A
process of Codex or Claude Code that does not prove its session (the variable
unset, as in `fuli mcp --call read_task_preferences --source-application
claude_code`) is refused: its token alone never binds. Small results retain the existing `complete`
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

A read of an open task replays the checkpoint decision of the entry that
opened it (design T2): the task keeps what the person asked of it
(`checkpoint_request`: `remember`, `update` or null, an optional field of the
Provider's task record), and the reader applies the entry's own rule
(`taskCheckpoint` in `src/graphiti/checkpoint-reason.js`) to it, so a task the
Stop hook closes says so instead of turning `checkpoint_required` to true on a
SessionStart restore or a host turn's refresh. A task kept before the field
still says true, and so does a task entered through a tool, whose routine
fallback eligibility only its entry knows. The field is sent only for a prompt
that asks to remember or update something. After an upgrade the hook runs the
new code at once while the Provider already running is the older one until it
restarts, and that Provider refuses a field it does not know (pydantic's
`extra_forbidden`); only for that refusal, of that field alone, the entry
begins the task without it (`provider-task-context-registry.js`), so the task
reads as one kept before the field and needs the checkpoint, rather than the
prompt failing to enter. A Provider that knows the field and refuses its value
is not answered without it: that refusal stands.

A hook that refreshes or restores its task in place reads through its own
process, which holds the cursors. It joins every page of the revision into the
complete result (`joinTaskPreferencePages`), with the task's own scope, then
compacts it and bounds it to the host's inline limit. The page budget applies to
the uncompacted reader result, so even a few preferences with the full rule
texts page; handing the model only the first page would block the turn and could
never confirm a delta (rec#76). No cursor ever reaches the model.

## Native boundaries

- Local Codex stdio accepts the host's per-request `threadId`, `sessionId` and
  optional `windowId` outside model arguments. An explicit remote host binding
  or sealed worker keeps its own admission authority. Legacy process identity
  remains a fallback. A new MCP process does not reset the session's record: a
  resumed host replays the same transcript, and another execution or window
  starts a new generation through `nativeGeneration` (rec#15).
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
  delivered before are taken as still seen. Its `SessionStart` with
  `source: "resume"` keeps the delivery state (pending frames and the
  generation start) and restores nothing; the next entry is a delta on the
  replayed frame. That Claude Code replays its earlier hook attachments is an
  assumption the macOS check of rec#47 verifies. The Claude adapter passes
  this as `replayedSources: ['resume']` to the shared
  `preferenceLifecycleOutput`; Codex passes none, so its resume is unchanged.
  A compaction Claude records in that transcript still starts a new
  generation. A resume into a new session ID (a fork) has no delivery state
  of its own, so its first entry is complete.
- Claude Code records form a tree: each names the one before it as
  `parentUuid`, and a rewind continues from an earlier record, leaving the
  turns after it in the file as an abandoned branch. A resume replays only the
  chain that ends at the latest record. So Claude evidence counts only frames
  and own messages on that chain (`link` in
  `src/agents/claude-code/preference-evidence.js`, walked by the shared
  reader): a frame on an abandoned branch confirms nothing, and the next entry
  is a delta on the last frame the chain still holds, or complete. A sidechain
  record or one without a `parentUuid` field is not on the chain; a transcript
  with no linked record at all is read in file order, as before. The chain is
  walked from the latest linked record in file order, which is the leaf
  Claude Code itself resumes; if the host has not yet written the new
  prompt's record when the hook reads, that leaf is the same one the replay
  starts from.

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
transcript, see above), fork, an execution/window change
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

Every entry may carry `conversation.active_elsewhere`: the same Agent's other
host sessions in the same scope seen in the last six hours, at most three,
newest first. Each row names the client, session ID, model and folder the
session's entries reported (graph 22 keeps one record per conversation and session, so a resume never rewrites history), when
it was last seen, its conversation ID and a one-line title of at most 96 bytes
(the checkpoint summary, else the person's opening words). The field is absent
when there is none, so an Agent working in one session costs nothing.

Known limit: the result of `resume_agent_conversation` is not tracked as a
frame, so the next entry of the resuming session sends the resumed messages
once more before they count as seen.

Metadata is private, locked across processes and contains hashes/cursors only.
It has a bounded pending set; unsupported, oversized or changed native files,
cache failures and absent instruction identity conservatively return full data.
Installing changed Hook definitions still uses the host's existing trust review.
These source changes do not install or approve daily Hook configurations.

## Task-entry skeleton (rec#76)

A hook frame also carries a skeleton that repeats from turn to turn of one
session: `agent_receipt`, the rule references (`task_guidance`,
`application_guidance`, `checkpoint_guidance`), `project_agent_context`,
`project_management_context`, `judgment_context`, `context`,
`task_knowledge_recall`, two paths inside the conversation (`conversation.guidance`
and `conversation.recovery.latest_checkpoint`, which repeats while no task
records a new result), and the hook's own label above the JSON. Every hook
frame that still shows one of these carries `skeleton_revision` (12 hex over
those fields and its label). A later hook frame leaves out each part that a
base shows byte for byte and names it in `skeleton_unchanged`. When the bases'
own parts, applied oldest first and under the frame's own parts, give exactly
the parts left out (label included), it is just their revisions: a bare one for
a single base, else a list, later over earlier. Otherwise it maps each base's
revision to the parts taken from it. A frame that names its label shows a
single sentence instead. `project_agent_context` and `task_knowledge_recall`
are compared field by field (`task_knowledge_recall.entities`,
`project_agent_context.match_basis`, …), since a new prompt changes a few of
their fields and keeps the rest. A field an older base gives as the frame has
it, but a later base of the chain overrides, is sent instead of named, so bare
revisions still apply; a part the bases give that the frame no longer has is
sent as `null` ("no longer present").

A base is a frame of the current context generation that the host recorded in
the session's own transcript, whose revision matches what it shows there, and
that belongs to the same owner: the same token (a host notification refreshed in
place) or any task this session began in the same project for the same Agent.
Every prompt of a session is a new task, and before rec#88 only a repeated
prompt could name the skeleton, so a six-turn Claude Code session carried the
whole ~8 KB skeleton six times. The session record keeps those tasks as
`[token, project and Agent]` hashes only (record version 4; a version 3 list of
`[token, prompt, owner]` is read as tasks). Another project or FLA, a frame
that was produced but not recorded, and everything before a compaction or
reset have no base, so those frames carry the whole skeleton. OpenCode's
plugin entry has no transcript FULI can read back, so its frames stay whole;
Cursor's prompt hook carries no context at all. A new session's transcript does not exist yet when its first
hooks run. When the host's SessionStart says the session has just started
(`startup`) and the transcript is not there, its boundary is its start (floor
0), so the first frame carries its revisions and a later turn confirms it from
the file. Any other missing transcript may have been moved away and keeps the
boundary unknown.

A revision stands for everything its frame gave: its own parts over what it
named itself, so a list or map resolves the same way however far back it
reaches. The revision covers the frame's fields, its label and its own
`skeleton_unchanged`. MCP results never take part. An in-place notification refresh
uses the same evidence rules for preferences and recovery instead of a forced
full frame.

## Scope counts

`context.task_scope_excluded_count` counts the preference items this task does not apply because of their scope: `task_scope_mismatch_count` of them name a work kind, workflow or session this task does not meet (present only when there are any), and the rest are the items whose scope this task does not state. `scope_unknown` lists the distinct keys of those, so several items can share one listed key and it can be shorter than the difference.

## First-reply habits line

The receipt of the first task of a new conversation ends with one more line:

    FULI 习惯：这个新对话为你准备了 N 条习惯 · [看看是哪几条](<console>/habits/<16 hex>)

It says 准备 (made ready), never 用了 (applied): FULI sees what it handed over;
only the reply shows whether the assistant followed them. N is the number of
preference keys the entry's delivery record keeps for the task (the delivered
`effective_preferences` with an id, deduplicated, at most 100): the same list
the linked page shows.

A frame bounded to a host's inline limit replaces that sentence with the two
numbers it can see once the fit has run (`src/conversations/entry-habits-line.js`,
rec#146 item 6):

    FULI 习惯：这个新对话为你准备了 N 条习惯：直接带上 M 条，另外 K 条随时可读 · [看看是哪几条](...)

M is `effective_preferences.length` of the delivered frame, K is
`preferences_omitted.count` and N is their sum: every preference the entry
resolved for this task. A later checkpoint, roundtable or pause receipt states
its N from the stored delivery row instead, which keeps each preference id
once and at most 100 (`MAX_DELIVERED_PREFERENCES`); the two numbers are the
same unless a preference has no id, two share one, or there are more than 100
— then the later receipt's is the smaller. The bounded frame cannot count the
stored way: it drops preference ids before it drops any preference (rec#75).
One language, like every other receipt line. Until this, a receipt read “你的 70 条习惯” beside
eight delivered ones. Only that one sentence changes; the link and every other
receipt line stay as they were. The receipt paths off the entry
(`storedHabitsLine`) do not know the split and say the prepared total. The link
names the task by the first 16 hex characters of its delivery key; the page
reads the local row (`GET /api/habit-deliveries/:taskKey`, owner reads only,
404 once the row is past the 180-day retention).

A conversation is new when the entry's `beginConversation` saved it and
recovered none (`status: saved`, `recovered_from: null`). The delivery-cache
counters are not used: they reset on compaction. The line appears only when N
is at least 1; a resumed task, capture off, no assigned Agent, an unsaved or
deferred conversation and a failed delivery write give none. The delivery
record (`recall-impressions` version 4, `opens_conversation`) remembers that
the entry opened the conversation, so a checkpoint, roundtable or pause receipt
that replaces the entry's says it again; a later task's receipt never gains it.
The entry adds nothing to its path for this beyond one value in the record
insert it already makes and the line itself. The AI never counts or writes the
line; it copies `agent_receipt.markdown` unchanged.

Cursor shows no such line. Its prompt hook begins the task and opens the
conversation; the AI's own `get_collaboration_preferences` call in the same
turn begins another task, whose conversation entry finds the session already
bound and so recovers it (`recovered_from` set). The hook's own receipt never
reaches the reply (Cursor's prompt output has no context field).

## Verification

Protocol, lifecycle and ownership tests use explicit synthetic records.
`npm run measure:context-delivery` replays the scenarios through the real hook
entries with three synthetic fixtures — `tiny`, the fixed-seed `scaled` one
(6–10 preferences of 120–400 B, 8–12 messages of 120–1500 B) and `many`, the
same generator with 73 preferences so the host's inline limit decides what the
model sees (rec#111, rec#137) — and prints one table per fixture, with the
uncached skeleton as a separate diagnostic, an `approxTokens` reading-cost hint
beside the bytes, and how the inline limit resolved (turns blocked, bodies
listed, items indexed, items omitted). `many` delivers less than the whole set
on purpose, so the pass/fail gate holds it only to what a bounded frame must
still be: every delta base locatable and nothing withdrawn still present. All
fixtures get the Provider's own recovery window (back to the third user
message, packed into the default 4000-byte `context_budget`), so the uncached
baseline holds only what the Provider would return.
`test/context-delivery-replay.test.js` holds the gates on these fixed fixtures:
no turn costs more than the uncached entry except a complete frame's revision
field (26 B), a `skeleton_revision` field (35 B) and a `recovery.withdrawn`
block (128 B), repeated prompts name the skeleton they already showed (rec#76)
and notifications of a session holding its context are one line, no scenario costs more in
total, the scaled scenarios that reuse context cost less, no turn needs a reread
under the delivery rules, and every model view is whole.
`test/agents/claude-code/host-event-turns.test.js` runs one Claude Code session
(`claudeHostEventSession`): a prompt, five notifications (two queued) and a
prompt with another recall. Every notification is one line, no preference body
is sent twice and the second prompt is an empty delta; the first host turn
after a compaction, and the one after a lost frame, get the whole context.
`test/agents/claude-code/entry-inline-budget.test.js` checks the inline
budget with a synthetic 60-preference entry: it fits, keeps every hard rule,
closing field and conflict, ranks boundaries first, counts what it leaves out,
is confirmed from its Claude transcript record and is followed by a delta; an
omitted preference is never delivered, a bounded frame never removes one still
in force, and hard rules alone over the budget are bounded too, with
`includes_always_inline`. `test/agents/claude-code/resume-delta.test.js`
reproduces rec#47 (D-69): the second turn is a delta after a `SessionStart`
resume between turns, with 26 hard rules and 5 general items, and with 26
unmarked judgment boundaries; a fork gets the complete frame, and after a
rewind and a resume the abandoned turn's frame is no base. The
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
