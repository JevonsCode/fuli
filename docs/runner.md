# Runners · 运行机

A runner is another computer of the same person that runs Agent clients (Codex,
Cursor, company Agents, any client that speaks MCP and loads Skills) while their
knowledge, preferences, FLAs and memory stay in **one** FULI, on the host
computer. Every runner thinks with its own clients; only what it reads and writes
of FULI goes to the host.

Where this is going: every FULI is a host and follows another one only where it says so, so a
computer can own some of the person's FULI and follow another for the rest.
`docs/runner-roles-design.md` is that design and which step is done.

```
runner (B)                                              host (A)
Codex / Cursor / other MCP clients                      FULI console
   │ stdio MCP (the same entry fuli setup writes)          │
   ▼                                                       ▼
fuli MCP process in runner mode ══ mutual TLS ══▶  runner listener (port 2730)
 · describes the folder a call names                     · chat tool set, held to a remote caller
 · cache of answers it read                              · project from the folder's facts
 · outbox of checkpoints the host has not confirmed      · applies each checkpoint id once
```

## What it borrows, and from where

| Idea | Source | Here |
| --- | --- | --- |
| One store, many places that act | the person's choice; FULI's human-authoritative store | No replica, no merge of two stores |
| A project is its repository, not a path; refuse when it does not match | Harness Remote | The runner sends the folder's facts; the host resolves them with the same rules as a local folder |
| Devices known by key, not address | the LAN roundtable's device certificates; iroh | One pairing pins both certificates; addresses are found again by fingerprint |
| An append-only log replayed by position, once | Durable Streams | The runner's outbox; the host remembers each replayed id |

Not taken: multi-primary replication and CRDTs (one store is the requirement),
syncing database files (corrupts them), last-write-wins (loses knowledge),
exposing the console on the LAN (Basic Auth on HTTP).

## Pairing

On the host: `fuli runner invite [--name NAME]` prints a one-use invitation (10
minutes). On the runner: `fuli runner join <invitation>`. The invitation carries
the host's addresses, port, certificate and a random code. The runner connects
pinned to that certificate and presents its own device certificate (the same
identity the LAN roundtable uses); the host records that certificate's
fingerprint only when the code matches. From then on every connection is mutual
TLS 1.3 with both certificates pinned. `fuli runner list` and
`fuli runner revoke <fingerprint>` manage runners on the host. Inviting a runner
gives that computer read and write access to the person's FULI knowledge, so it
is the person's own decision on the host (`local_user_only`).

The host lists a runner under the name the person typed at `invite` (`--name`),
with the name the joining computer gives itself beside it (`join --name`, else
its computer name). Each pairing is also a notice in the console's
「最近你可能需要知道的事」, naming both, with 「撤销」 on the notice itself
(`DELETE /api/runners/<fingerprint>` after one confirming click), so a pairing
the person did not make shows and ends in one place; a used invitation's error on the runner
points at `fuli runner list` and `fuli runner revoke`.

`join` then sets up the runner's clients exactly as `fuli setup` does (MCP entry,
Skills, Codex instructions), without starting a graph runtime. In runner mode the
same MCP command serves through the host. A client's prompt hook is forwarded to
the host, which enters the task for the client's own session and the folder the
client is in, exactly as a local hook would; the transcript stays on the runner.
A client names its session only to its hooks (Codex gives MCP servers no thread
ID), so this is how a runner's client gets a task token. When the host is away,
the hook tells the model to enter the task through FULI's MCP tools instead.

`fuli runner leave` on the runner ends the pairing there: it deletes the runner
store (the host, the cached answers, offline task tokens and the outbox). The
host lists the runner until the person revokes it there.

## Routes: what this computer follows

Which parts of the person's FULI this computer reads and writes on another one is a short table,
`runner/routes.sqlite` (docs/runner-roles-design.md §3). A scope is `global` (habits, profile, the
FLA roster, Jefa), `default` (whatever has no route of its own) or `project:<id>`, and each has
one owner: this computer or the paired host. A computer with no routes owns everything it has.

- `fuli runner join` is 「follow everything」 on the joined host: `global` and `default` go there,
  and so does any scope that followed another host. A runner paired by an earlier version gets
  `global → host` and `default → host` on its first start and behaves exactly as before, outbox
  included. `fuli runner leave` deletes the routes.
- `fuli routes list` shows them; `fuli routes follow SCOPE HOST` points one scope at the paired
  host (its name, or 8 or more characters of its fingerprint); `fuli routes scope-of PATH` prints
  the scope of a folder (a relative path from where it is run). Which project a folder is, is the
  host's answer by the host's own rules: what the host last resolved for this very folder (kept from
  its task entries), else the host's resolver itself (`resolvePersonalProjectPath`: repository root,
  a worktree's original repository, the folder's name, a child project's marker) over the projects
  this computer knows. A folder of no known project is `default`.
- `fuli routes follow` first checks that this computer has no data of that scope already (design
  §7.1): on a computer with a FULI of its own, `global` and `default` are refused, and a project is
  refused when that FULI has it (`scope_has_local_data`). A graph this computer prepared for itself
  and found empty (see "This computer's own runtime") is no FULI of its own here. The projects are
  asked of this computer's own Provider directly, never of the console port: on a follower that port
  answers with the host's pages and API, so asking it asked the host (fixed in step 3a). While the
  Provider is stopped (no scope is this computer's), what the preparation found in the graph is the
  answer; nothing starts that graph on a follower but the preparation. A graph that was never checked
  and does not answer (`local_fuli_not_running`), one that answered with an error
  (`local_fuli_refused`) and settings it cannot read (`local_fuli_unreadable`) are said apart.
  Moving a scope between computers is a later step.
- `fuli routes local FOLDER|project:<id>` keeps a new project on this computer (step 3c; "Projects of
  this computer's own" below). It is refused, with the reason that holds here and what the person can do
  now, and nothing is written, when: the scope is `global` (`global_has_one_owner`: habits, profile, the
  FLA roster and Jefa's board have one owner, the computer it follows; D1, D2) or `default`
  (`default_stays`); the host has the project (`project_on_host`: moving a project is a later step, design
  §7); this computer's runtime is not ready (`local_runtime_not_ready`: never prepared, being prepared,
  not enough disk, or the last attempt failed), its graph is under another space (`local_space_differs`)
  or not made under the host's yet (`local_space_not_yet`); the host is too old to take writes to global
  (`host_needs_update`) or its first copy of global has not arrived (`waiting_for_copy`); or the host
  cannot be asked now (`host_needed_to_check`, `host_could_not_check`).
- `fuli routes list` also lists each project this computer knows of that has no route of its own and
  goes as new folders do, with the computer it belongs to, and this computer's runtime state.
  `fuli status`, `fuli runner status`, the state band and `/local` say per project 「本机 / 主机 …」.
- Each call is routed before anything is sent: by the scope of the folder it names (`global`
  without one), or by the computer that entered the task its token names, so a checkpoint goes
  back to the computer that entered the task whatever the routes became. A call whose owner this
  computer cannot reach is refused with the command that fixes it, never sent to another computer:
  `scope_owner_not_paired`, `task_owner_not_paired`, and `scope_owned_here` (`global` or `default`
  routed to this computer, which only a store edited by hand holds). A call for the host that names a
  project of this computer anywhere but the fields that decide where it goes (a nested argument, a list
  such as `personalProjectIds`, another field's name for it such as `contextPersonalProjectId`) cannot be
  told apart and goes nowhere: `scope_not_decidable`. When the routes themselves cannot be read (a newer FULI wrote
  them, the file is damaged, or it waits for a migration), the follower's MCP server still starts and
  every call answers `routes_unavailable` with the reason and what to do; nothing is sent anywhere.
- A task token says which FULI issued it (design §4.4): a token the host issues reaches the client
  as `fuli-from-<the host's fingerprint, 16 characters>.<the host's own token>`, and the host gets its
  own token back. A token passed as the host wrote it goes by the owner remembered for it here: only
  its SHA-256, kept 30 days from its last use, never the token. Every mention of the token in a task
  entry's answer has the prefix (the recovery calls it suggests, such as `read_task_preferences`,
  included), and so does every mention of a call's own task token in the answer to that call (for
  example `read_task_preferences` or `resume_agent_conversation`). An error answer is passed on as the
  host wrote it. The FULI that issued a token takes it back with its own name on it (a conversation
  begun on a follower and continued on the host), refuses one that names another FULI
  (`task_issued_elsewhere`), and says so when it cannot tell its own name, having no device identity
  where it looks (`task_issuer_unknown`), never that the token is another FULI's.
- A computer that follows nothing loads none of the router's modules.

## This computer's own runtime

Every FULI is a complete FULI (docs/runner-roles-design.md §2), so a computer that follows a host gets
its own graph runtime too (step 3a). The first time its console starts with this version — `fuli
start`, FULI.app, or the setup `fuli update` runs — it prepares that runtime in the background:
`fuli runner prepare-local`, a detached process writing to `logs/runner-local-runtime.log`. Nothing
for the person to do, and nothing is routed to it until a project is made this computer's (step 3c,
"Projects of this computer's own"):
the calls that go to the host are not affected by a preparation that is under way or failed.

- It is the setup a first start does, personal graph only (native Neo4j and the Provider, the personal
  space named as `fuli setup` names it), without a console: the console port stays the follower
  console's, the one listener there.
- Only a graph the preparation makes is set up. A data directory that already had a graph of its own
  (`graph-runtime.json` from before any preparation) is left alone: not started, upgraded or changed,
  since a format step there would need the person's confirmation and a follower has nowhere to give
  it. That is said as 「本机已有图谱，这一步没有动它」.
- Before anything is downloaded it checks the free disk space (at least 3 GB); below that it says how
  much is free and how much is needed, and downloads nothing.
- Once set up, it asks the graph which projects it holds, copies the host's `global` into it once ("The
  copy of `global`" below), then **stops Neo4j and the Provider again**
  while no scope is this computer's: a follower may be a light computer. It stays running only while
  a project is this computer's, or while the first one is being made.
- `runner/local-runtime.json` records the outcome (process state, not FULI data: without it the next
  start prepares again). One preparation runs at a time: the preparing process holds
  `runner/local-runtime.lock` (an OS lock, gone with the process however it ends), and a start claims
  `runner/local-runtime.claim` before spawning it, so two starts at once spawn one.
- At the next start of the console (or `fuli setup`) only a preparation that was cut short, found too
  little disk, or ran under another FULI version is tried again by itself. Any other failure would fail
  the same way, starting Neo4j each time, so it waits for 「重新准备 / Prepare again」 on `/local`
  (`POST /__fuli-follower/prepare-local`, from that page only) or `fuli runner prepare-local`, and the
  state says so; never in a loop.
- Where it stands, and whose space its graph is (「本机图谱与主机同一空间」 / 「本机图谱连上主机后建」 /
  「本机有自己的数据（空间与主机不同）」), is said in the state band (「本机运行时已备好（未运行）」), on `/local`, in
  `fuli status`, `fuli runner status` and `fuli routes list`: not prepared, being prepared, prepared
  and not running (no project is this computer's yet), not enough disk, or failed with its reason.
- **The graph is made under the host's personal space** (docs/runner-roles-design.md §12): nearly
  every record ID and `group_id` is derived from the personal space ID and the Provider's
  `provider_id`, and a copy of the host's `global` lands only in a graph with the same two. The
  host's hello says both (`space: { id, providerId }`) with its graph format and copy protocol
  (`formats`); the preparation asks it once and creates the space under that ID
  (`POST /v1/spaces` with `id` and `provider_id`, taken only while the graph has no personal space,
  and only under the same `provider_id`: `local-personal` on every installed FULI; refused with
  `personal_space_exists` or `space_provider_mismatch`, nothing changed). The Provider is started with
  `FULI_GLOBAL_REPLICA=true` (set by Node at every start of a follower's Provider, from the routes
  store, never kept): `global` is the host's, so no default record of it is written there (see
  "`global` on a follower" below).
- **While the host does not say its space** (it is away, or runs an earlier FULI), the runtime is
  installed and checked but no graph is made: 「本机图谱：连上主机后建」, or 「主机的 FULI 还不能给出
  空间信息，升级主机后继续」. The follower console starts the preparation again by itself the first
  time the host says its space; nothing for the person to do, and everything else works as before.
  A host answers its hello at once, without waiting for its Provider: until that Provider has said
  the space once, the hello says it is not read yet, and the follower waits as for a host that is away.
  When a preparation the console started ended without reaching the host, the next one waits a minute,
  twice as long each time after (up to half an hour), and the state says 「上次尝试没连上主机，稍后自动再试」.
- **A graph step 3a made under a space of its own** (a `ready` record without `space`) is looked into
  again before anything moves: started (as a follower's), asked for its projects and for any record of
  `global` besides the defaults FULI makes by itself (habits, knowledge, FLAs the person hired), stopped.
  With neither, its whole instance directory (`native-runtime/personal`) and the `graph-runtime.json` naming
  it are set aside in `native-runtime/recovered/<time>/` with a note (`follower-space.json`), never
  deleted, and the graph is made again under the host's space; the state names the folder, and the
  note says, in both languages, why it was moved and which folder goes back where. If that
  fails, the graph goes back where it was (what the attempt made is kept in `<that folder>/attempt`)
  and 「重新准备」 tries again. With a project or such a record, it is the person's and stays as it is.
- **FULI data of this computer's own** (a graph from before any preparation, or one with a project):
  not moved and not given another ID. The state says so wherever it is shown: 「这台电脑有自己的 FULI
  数据，空间和主机不同，所以现在不能在这台电脑上拥有本机项目」, that projects go on on the host, and
  that merging or moving that data comes in a later version; `fuli routes local` refuses with
  `local_space_differs`. `runner/local-runtime.json` keeps `space` (`same` with its ID, `later` with
  the reason, `different`) and the formats this computer's Provider said (process state, as before).
- `fuli runner join` takes a data directory with a graph this computer prepared and found empty, so
  joining again after a revoke or `leave` still works; a graph with the person's data is refused as
  before. While a preparation is under way, `join` and `fuli routes follow global` wait for it and say
  so (`local_runtime_preparing`). Starting the data directory as its own FULI (after `leave`) forgets the record.

## Projects of this computer's own

A computer that follows a host may keep a **new** project, one the host does not have, on itself
(docs/runner-roles-design.md §11 3b/3c). Its tasks, knowledge, checkpoints, FLA assignments and project
memory, and Jefa's board for it, are then answered by this computer, also while the host is away; what
it writes to `global` (the person's habits, an FLA's global memory, the use of a global habit, a new
FLA) still goes to the host, which owns `global`.

- **One way, three entries** (`make-project-local.js`): 「放在这台电脑」 on this computer's `/local`
  page (a folder recently worked in here, or a folder typed in; `POST /__fuli-follower/make-local`,
  from that page only), `fuli routes local FOLDER|project:<id>`, or the person's AI with the follower's
  own tool `keep_project_on_this_computer`, listed only while a project can be kept here and called only
  when the person asks. Each checks this computer first (its runtime ready under the host's space), then
  asks the host: it must take writes to global (`globalWrites` in its hello), its first copy of global
  must have arrived, and it must have no project of that id, that name or that folder (the host's own
  resolver). With the host away nothing is made, since the host could make the same id meanwhile.
- **This computer's graph is started for it.** While no project is this computer's its Neo4j and
  Provider are stopped; making one writes `runner/making-project` (process state, fresh for 10 minutes),
  the follower console starts the graph for it as for an owned project, and the maker waits up to two
  minutes for it (`local_runtime_not_running` otherwise, with what an AI is told everywhere FULI does
  not answer). The project is made there with `createOnly`, and only then routed here with its folder;
  one made whose route was never written is routed the next time. The project id may differ from the
  folder's name: the route keeps the folder.
- **Calls and hooks by folder.** A call naming the folder, the project id, or a task this computer
  entered is answered by this computer's own half of the follower's MCP server, its task token named
  `fuli-from-<this computer>.…`. The entry says where `global` came from (「全局习惯来自 <主机> 的副本，同步于
  …」) and how many writes to global wait for the host. The lifecycle hooks of that folder run here too,
  for Claude Code, Codex, Cursor and the plugin clients (OpenCode, DeepSeek Harness); a hook of such a
  folder that cannot run here says so, and is never sent to the host.
- **Writes to global** go to the host in one outbox entry per checkpoint: delivered while it answers,
  queued while it is away, held for a host too old for them or one that kept failing (sent again by
  themselves at its next hello). `/local` lists them in words, held apart from refused.
- **A new project's lead.** The first task opens a recruitment as on any FULI; the FLA roster is the
  host's, so the recruitment waits (`blocked / recruitment_on_owner`) while the host makes the FLA under
  the recruitment's id. Once the next copy of global brings it, this computer finishes the assignment and
  the task goes on, also when the host was away meanwhile. A recruitment that needs approval is approved on
  this computer, whose project it is.
- **The console by project.** A console request for one of these projects is answered here; one naming
  none goes to the host; one naming such a project where this computer cannot tell for certain (a part of
  the console it does not serve, a body it cannot read or larger than 1 MiB, a project of both computers,
  or the project only in a nested field, a list or another query value) is refused here and never carried
  to the host. The merged project list marks each project `this_computer` or `host` and says when either
  side cannot be listed now.
- **Backups.** With a project here, `/local` (or `fuli graph export`) backs up this computer's whole graph;
  a backup is restored only to the computer and space that made it, and the next sync then verifies the copy
  of global. A data format update of this computer's stores is confirmed on `/local` too.
- **Leaving the host** (`fuli runner leave`) copies the whole graph to `native-runtime/recovered/` first,
  then releases only the host's copy: this computer's projects, their assignments and memory, the FLAs they
  point at and the custom occupations those FLAs name stay, as this computer's own. The leave summary counts recruitments still waiting for the host.
  After leaving, cancel those requests and request the FLAs again on this computer. While paired, a recruitment withdrawn before dispatch stays here. If a request already reached the host, an FLA it created stays on
  the host's roster, under its origin; listing and clearing those on the host comes with step 4.
- A project the host already has stays the host's (`fuli routes follow` of a project this computer holds is
  refused: moving one is a later step).

## The console on a runner

A runner has a console of its own: `fuli start` (and
FULI.app's start) runs `fuli runner console`, which listens on this computer's loopback at its usual
console port (2727 unless Settings say otherwise).

**This computer's own page is `/local`.** It opens whether or not the host answers, and says who
this computer follows, whether that computer answers now, when it was last reached, which capability
runs here and which on the host (and what each one does while the host is away), and every record
still waiting to be delivered — one by one, with what it is, when it was made, where it stands and
why — with 「现在重试」 beside them. It also says plainly that this beta syncs only on a network
both computers are on.

**A state band sits on top of every page.** One line: who this computer follows, online or not, when
it last reached it (the last time the host answered anything), how many records wait, and where this page's data came from. Where it came from is
not guessed: every answer this entry serves carries `x-fuli-source` (`local`, `host` or
`unavailable`), and the band (`src/runner/follower-band.js`) reads that header off the page's own
requests. `fuli status` and `fuli runner status` print the same facts from the same answer
(`src/runner/follower-status.js`), so the three never disagree about whether the host is reachable.

**The host's pages come over the paired channel.** Each request goes over the paired mutual-TLS
channel to `/runner/1/console/…` on the host, which forwards it to its own console on loopback
(`src/runner/console-relay.js`), so pages, API calls and live event streams behave as on the host,
and the receipt links the host gives (`http://127.0.0.1:2727/…`) open on the runner too.
`/remote/<host>/…` names the host a page belongs to: the name is the host's own (a slug of it) or the
start of the fingerprint the pairing pinned, and any other name reaches nothing (404 `unknown_host`).
An HTML page asked for under that prefix is answered with the host's own path on this origin, because
the host's console is one page application that reads its own absolute paths.

- The entry answers only on loopback under its own name (no DNS rebinding) and refuses any other
  site's `Origin` before the channel; the host then gives the runner's own page the console's
  origin. The host keeps the runner's identity when forwarding to loopback. Pairing, host
  software updates and repairs, old installation data and detailed diagnostics belong to the
  host console. The runner can still read the public version at `/api/system/version`.
- 客户端接入 (`/api/system/client-connection…`) answers on the runner itself: it lists, connects,
  restarts and adds this computer's clients, with the same entries `fuli runner join` writes.
  Nothing of it reaches the host. Because it is the runner's own page, it says so at the top: this
  computer is a runner, its host's name, that a runner's hooks load nothing so every client here
  depends on the model entering the task through FULI's MCP server, and, when the two differ, which
  computer runs the older FULI. The host's relay refuses those writes, and opening a session
  (`/api/session-launch`), with 403 `host_computer_only`, so a runner never changes the host
  computer's clients.
- While the host is away, a page says so — naming the host's page that cannot be shown — and shows
  this computer's own console below it; API calls answer 503 `host_unreachable`. A revoked runner's
  entry reaches nothing.
- 「现在重试」 (`POST /__fuli-follower/sync`) delivers the outbox now. It is taken only from this
  computer's own page (its own `Origin`); a program on this computer has `fuli runner sync`.
- Which computer answers a path is decided in one place (`whoAnswers` in
  `src/runner/follower-console.js`): this computer's own paths here, and the API of the projects this
  computer owns, by scope (`console-scope-paths.js`); every other one on the host.
- `fuli status`, `fuli stop`, `fuli restart` and `fuli open` manage this entry; FULI.app starts it
  and never runs `fuli setup` on a runner. `fuli setup` (and the setup `fuli update` runs) on a
  runner sets up its clients and starts the background preparation of its own runtime (above); it
  never starts a second console or writes over the pairing.
- The commands that would start this computer's own graph runtime as an ordinary FULI's, or write its
  graph, refuse on a runner before anything is stopped, started or written: `fuli graph import|export|
  abandon-import`, `fuli graph runtime install|update|rollback|uninstall|recover`, `fuli graph migrate`,
  `fuli migrate reconcile-knowledge` and the desktop app's recovery actions (恢复, 放弃这次导入, 保留新版本)
  (`src/cli/follower-graph-refusal.js`). They say that FULI manages this graph (it holds a
  read-only copy of the host's `global`), that backups and migrations are made on the host, and that
  `fuli runner leave` stops following it. `recover` points at 「重新准备」 when the page shows it and at leave
  otherwise; `recover --preview` and `fuli graph runtime unlock` are not refused. Any other start of a Provider
  for this data directory (an import's reconcile, a runtime update's restart) takes `FULI_GLOBAL_REPLICA`
  from the routes store when its caller does not say (`providerGlobalReplica`), so it never starts as an
  ordinary FULI's here.
- `fuli migrate status|preview|apply|rollback|restore|prune` work on a runner's own stores (`runner/*.sqlite`,
  its JSON stores): its console sends the data format page to the host, so this is where they are confirmed.
  Only the graph step is left out (`graph: null`, no Provider asked), and the output says so: 「这台电脑跟随主机，
  本机图谱由 FULI 自己管理，这里不包含图谱。」
- **A pairing, not a missing `graph-runtime.json`, is what makes a computer follow a host**
  (`src/runner/runner-mode.js`). A paired computer that a start or `fuli setup` later wrote a
  runtime file for used to stop counting as a runner, and its clients then silently used an empty
  local FULI (docs/runner-roles-design.md §1.1). `fuli runner leave` is the one way to end a
  pairing; when a client's process still holds the store open (Windows), `leave` leaves
  `runner/left` beside it so the computer is no longer a follower. `fuli runner join` still refuses
  a data directory that holds a FULI of its own.
- The host's and the runner's console ports should match for receipt links to open as they are.

## What a runner's call may do on the host

Every call a runner makes runs as that runner's, known by its certificate
fingerprint (`src/app/agent-request-context.js` `runAsRunnerCall`), and is held to
what a call from another computer may do:

- A wake of the person's Agents (`message_agent`, `agent_chat`, a group
  discussion) is read-only, never in Codex on Windows, and loads only FULI's own MCP server, as a LAN
  roundtable ask from another computer is; it never goes to a desktop app
  conversation and gets no stand-in. A fresh session for it starts in an empty
  folder FULI owns (`roundtable-wake` in the host's data directory), never in
  the console's own. The ask records the runner's fingerprint and its origin.
- The wake carries that origin to the woken session (`FULI_ROUNDTABLE_ORIGIN`),
  so every ask that session makes in turn is held the same way, one hop on and
  further; a paired device's ask (origin `remote`) is carried the same way.
  Asks between the person's own Agents on the host keep their full wakes.
- A folder the runner names is on the runner: it is never used as a working
  folder on the host, nor accepted as one of the host's folders for a project.
- `run_delegated_action` is refused (`local_user_only`): a console change is the
  person's, made on the host.
- The runner's MCP sessions get none of the console's environment.

The fingerprint is recorded with each ask and each applied checkpoint id; task
records in the graph do not carry it yet.

## MCP sessions on the host

Each FULI MCP process on a runner holds one MCP session on the host. The host
keeps at most 64 sessions for all runners together, a backstop against
something that opens them in a loop, and one runner may hold at most 48 of
them: far more MCP processes than a computer runs, and well past the 16 a
runner was once held to, but never all of them, so another computer always
finds room. Connections are counted apart (see "Finding the host again").

- A runner's MCP process ends its session on the host when it exits (its
  client closed stdin, SIGINT or SIGTERM, or the client disconnected): it sends
  MCP's `DELETE` for the session, waits for it at most 2 seconds, and the host
  releases the session at once. A process that stops using a session to open
  another (its connection dropped, a call lost its answer, the MCP relay
  switched to a newly installed version) ends the old one the same way, waiting
  at most 1 second. A process that is killed, or cut off before the `DELETE`
  arrives, holds its session until it has been idle 30 minutes.
- So close clients, MCP processes and test scripts once they are no longer
  used, reuse one connection within a session, and never open new ones in a
  loop. FULI tells every client's AI the same in its MCP instructions.
- When the host answers but refuses a new session (the limit, or a failure on
  its side), the call answers `host_refused` with the HTTP status and the
  host's reason, as the host wrote it. At the session limit the host is the
  only side that knows whose sessions are open, so its reason says how many
  this computer holds, how many are open in all, and whether to close clients
  here or on another runner; the runner never guesses that they are its own.
  It is not taken for the host being away: no offline answer,
  no `runner-offline-` task token. A refusal of a runner the host does not
  know (403) is checked through hello as before (`runner_revoked`). The runner
  also writes it to its own diagnostics (`fuli diagnostics` on the runner,
  operation `runner.session_open`, code `host_refused` with the status and
  reason, or `host_session_failed`), once until a session opens again.
- `fuli runner status`, and `fuli status` while the runner's console runs,
  show how many sessions this runner holds on the host, and how many there are
  in all against the limit.

## Finding the host again

The host listens on its private LAN addresses and follows them as they change
(checked every minute), and advertises `fuli-runner` over mDNS with its
fingerprint while a runner is paired. The runner tries every address it knows at
once (2.5 seconds in all), then looks the fingerprint up over mDNS (up to 3
seconds, done at the first answer), taking only addresses a host serves from it:
private ones, and the 100.64.0.0/10 range a VPN or mesh tool hands out. Any
address is accepted only when it answers with the pinned certificate.

Each address is tried both by the default route and from each physical
adapter's own address (Wi-Fi, cable). Whether that gets past a VPN depends on
the system:

- **macOS:** it helps. Scoped routing makes the source address pick the
  adapter, so when a VPN claims the host's subnet and the default route
  disappears into its tunnel, the request bound to the Wi-Fi address still
  reaches the host directly.
- **Linux:** usually not. The route is chosen by the destination, so binding
  a source address does not change which adapter the request leaves by.
- **Windows:** not tried. Windows has used the strong host model since Vista,
  under which binding the source address may well pick the adapter as on
  macOS, but no runner has been tried there behind such a VPN.

Where it does not help, a VPN that swallows the host's subnet needs
`fuli runner add-address` with an address reachable through the VPN itself
(see "Two computers on different networks"). The route that answers is the
one every later request takes.

The host's `hello` names its current addresses and the runner keeps up to 16,
newest first, dropping the one learned longest ago, so each network the two
meet on (home, office, a VPN) is tried again next time and a host that moves
once more is still learned. The address that last answered is kept apart and
always tried. mDNS does not cross subnets: on a network
where the two computers sit in different subnets, the first time there, tell
the runner where the host is with `fuli runner add-address ADDRESS` (the host's
`fuli runner list` shows its addresses); it is kept from then on.

The listener closes a connection that has not finished its TLS handshake in 10
seconds and holds at most 256 connections over all the addresses it binds —
counted across them, since it binds one server per address. Any device on the
network can finish a handshake (the certificate it presents is the route's to
judge, not the socket's), so one source address may hold at most 24
connections until it has shown a paired runner's certificate; a paired
runner's connections are not held to that share, however many MCP processes it
runs. A client
waits for the tool list when its MCP server starts: when the host has not
answered within 4 seconds the runner answers with the list the host last gave,
and tells the client to list again once the host's differs.

## Two computers on different networks

There is no relay, by decision (Jevons, 2026-11-23): the runner reaches the host directly or not
at all, and none is planned. Two
computers that are not on the same network (home and the office) need a VPN or
mesh tool that puts them on one network — Tailscale, WireGuard, a company VPN
that lets its clients reach each other. Then:

1. Turn the VPN on, on both computers.
2. On the host, run `fuli runner list`. It prints the addresses the host
   listens on, the VPN's among them (Tailscale and many company VPNs hand out
   addresses that start with `100.`).
3. On the runner, run that one command with the host's VPN address:

   ```
   fuli runner add-address 100.84.12.9
   ```

   It is kept from then on, tried first, and the outbox is delivered at once.
   The same is a button on the runner's own console page (`/local`): while the
   host does not answer it offers 「添加主机地址」, one button and one field.
4. `fuli runner status` on the runner says whether the host answers and from
   which address.

An invitation can already carry such an address, so a runner that joins while
both are on the VPN needs none of this. A company network that isolates its
clients from each other blocks both computers equally: use a cable, another
shared network, or a mesh tool that does not rely on the local network.

## FULI versions on the two computers

A runner and its host each have their own FULI, and nothing keeps them on the same version: a runner
left in an office stays on the version it joined with (rec#144). The host's version comes with the
hello the runner already exchanges with it, so `fuli status` and `fuli runner status` on a runner,
and the runner's 客户端接入 page, say which copy is older. The runner's side is what its open client
sessions run (their MCP servers keep the version they started with until restarted), or the
installed copy when none is open; the same release spelled differently (`v0.29.0`, build metadata)
is not a difference. It is only said: a call both versions understand goes through as before, and
nothing here refuses anything. When the runner is older the page offers 「让 AI 来做：更新这台电脑的
FULI」 (the console's one AI entry), which hands an AI client on this computer a prompt naming the
host's exact version — `npm install --global fuli-context@<host version>`, `fuli restart`, which
sessions to reopen, then `fuli runner status` — never "or newer", which would put the runner ahead
and turn the notice around. When the host is older the page says to update from the host's
console, because a runner's page cannot run the host's update (the relay refuses it). The
host does not show a runner's version yet: a follower sends its FULI version with every hello
(`x-fuli-follower-version`), and its graph format and copy protocol once its own Provider said them
(`x-fuli-follower-graph-format`, `x-fuli-follower-replica-protocol`); the host does not read them yet, so
the notice is on the runner's side only. The copy of `global` (below) compares the two graph formats and copy
protocols itself and, when they differ, says so and imports nothing until both run one FULI version.

### `global` on a follower

`global` has one owner, the host (D1). A follower's own Provider is started with
`FULI_GLOBAL_REPLICA=true`, and then writes none of `global`'s default records: at its start
(`_ensure_personal_space_defaults`: the recruitment policy, the four fixed roles, retiring the old
coordinator, the name-key tidy-up), and on demand (`/v1/project-agents/system-hr`,
`/v1/project-agents/system-coordinator`, and a task's coordinator, which also merged the old AR into
Bole). They come with the host's copy of `global`; until it arrived, a call that needs them answers
409 `global_not_synced` (「全局还没从主机同步过来」), never an internal error; nothing on a follower calls
them yet (every call goes to the host). They come with the copy below. The first import of
`global` takes over the fixed roles and the recruitment policy this graph made itself before (a
Provider started before it was a follower's): the owner's properties replace them, they are marked as
the owner's copies, and this computer's own edges on them stay; one the owner does not have goes as
any copy the owner no longer has. Any other record of this computer's under an ID the envelope names
is still refused (`replica_scope_owned_here`).

### The copy of `global`

A follower keeps a **read-only copy** of the host's `global` in its own graph (docs/runner-roles-design.md
§3, §12 "The sync loop"): the host's export imported under the same IDs, marked as the host's, never
written otherwise. Nothing reads it yet: every call still goes to the host. It is what later steps read
when the host is away and what a project this computer owns will take its habits and FLAs from.

- **The host's side.** `GET /runner/1/scope?scope=global&part=digest|envelope` on the paired channel, for
  a paired, unrevoked follower only (403 `runner_unknown` otherwise). `part=digest` answers the digest,
  space, graph format, copy protocol, `complete` and size, without the envelope; `part=envelope` answers
  the envelope exactly as the host's Provider wrote it (never parsed and written again), with its digest in
  `x-fuli-scope-digest`. One export answers both: it is kept a minute (`SCOPE_EXPORT_KEEP_MS`), and asks
  while one runs wait for it, so the host exports `global` at most once a minute however many followers ask.
  Only `global` is offered (`scope_not_offered` otherwise), and only by a host that owns it: one that itself
  follows another computer for `global`, or whose Provider keeps it as a copy, answers 409
  `scope_not_owned_here`. Past 64 MB (`SCOPE_ENVELOPE_MAX_BYTES`) it answers 413 `scope_too_large`, never a
  cut envelope. A Provider that does not run answers at once 503 `host_provider_unavailable`; one slower than
  20 seconds 503 `host_provider_slow` (its export goes on and is kept for the next ask). The hello never waits
  for any of it.
- **When the follower syncs.** Once when the preparation has made its graph under the host's space (Neo4j
  runs then anyway), before Neo4j stops again. While a copy is **owed** (none arrived yet, as on a follower
  prepared by an earlier 0.29.0 beta or one whose first sync failed; or FULI changed since the preparation,
  `copyCatchUp`), the preparation runs once more at the console's start: it first asks the host's hello and
  digest with nothing started, and starts Neo4j only when the host answers and would not say the same refusal
  or version mismatch again; it syncs, then stops Neo4j. After a FULI update that run also lets the Provider
  bring the graph format up to date; a graph whose format waits for a step a person confirms, holding only the
  copy, is set aside in `native-runtime/recovered/` (never deleted) and made again, and one holding the
  person's data is left as it is and said so. A console that runs keeps trying an owed copy only once the
  host answers, after a minute and then twice as long each time, up to 30 minutes. Once a copy arrived, only
  while this computer's own runtime **already runs**: once a minute the console reads whether its process
  record names a running Provider, and only then asks it on loopback; never started for a sync. While it runs:
  once when the console first finds it running, then every 10 minutes (`GLOBAL_SYNC_EVERY_MS`), and sooner
  after a round the host did not answer, once the console reaches the host again. Each round asks for the
  digest; the envelope is fetched only when the digest is not the copy's, or when the round verifies (the
  preparation's syncs, a running console's first and every sixth): the digest kept is what this computer last
  imported, not what its graph holds, so a verifying round imports anyway and writes back whatever differs.
  There is no 「现在同步」 button, since that would start Neo4j.
- **Before it imports**, in this order, each said in the state when it stops there: `global` is routed to the
  host (`globalIsCopyHere`); the host's hello says its space and versions (else it waits, or the host runs an
  earlier FULI); the host's space ID is this graph's, as the hello and then the export itself say it; both
  graph formats and copy protocols are the same, as the hello and then the export say them (else nothing
  is fetched or imported until one changes); the envelope is `complete`.
- **The import.** `owner` is the certificate fingerprint the pairing pinned, never anything the envelope
  says. It runs under the preparation's lock (`runner/local-runtime.lock`), so one import runs at a time
  and none while a preparation starts or stops the runtime; a round that finds the lock held skips. The
  envelope's bytes go to this computer's Provider as they arrived. A refusal (409, 422) is recorded with its
  code and message as said, and is not tried again while the host's digest, both versions and the space are
  what they were. A refused digest (413, 409: there is no digest to compare) is not asked again while both
  versions and the space are what they were, for a day.
- **What it records.** `replica = 1` is written on the `global` row before the import writes anything (so
  `fuli runner leave` knows a copy may be there even if the process ends mid-way); success writes
  `replica_synced_at` on the `global` row of
  `runner/routes.sqlite` (the columns were there; no format change), and `runner/global-copy.json` keeps the
  digest, when the copy was last checked and when its content last changed, and how the last round went
  (process state: without it the next sync imports once more, which writes nothing the copy has).
- **What it says** (the state band, `/local`, `fuli status`, `fuli runner status`): not synced yet and when the
  first sync comes; last checked and last changed; the host away (「上次同步时主机不在线，连上后再同步」), the
  host's graph not running or busy; 「主机的 FULI 还不能提供副本，升级主机后继续」 (a host of an earlier
  version answers 404); the two FULI versions differ, with both formats and which computer to update; this
  graph is another space than the host's; refused, by which side, with its code and reason, and that nothing
  was written. Each non-synced line adds that calls to the host are not affected; none names a command.
- **`fuli runner leave`** sets a graph that holds the host's copy aside, whole, in
  `native-runtime/recovered/<time>/` with a note (never deleted), and forgets the preparation's record: after
  leave this data directory is a FULI of its own, whose start would write the defaults of `global` under the
  IDs of the host's copies. The next start makes a graph of its own, as a first start does. While a
  preparation or an import holds the runtime, leave says so and changes nothing. A graph no copy ever arrived
  in is left as it is. A graph that holds anything of this computer's own (a scope routed here, or a project or
  a record of `global` besides the copy and the defaults, as its running Provider counts them, else as the last
  preparation found them) is never moved whole: leave refuses (`local_data_here`) and changes nothing. None can
  be there today; the step that lets a follower own a scope must set aside only the copy.
- **No write fallback yet.** Nothing on a follower writes its own graph but this import: the MCP entry, the
  hooks, the console and `fuli whoami` go to the host, and the preparation and `fuli routes follow` only read
  it (docs/runner-roles-design.md §12). Refusing an ordinary write to a copy (`replica_read_only`) comes with
  the step that lets a follower own a project.

## Who owns this project (`fuli whoami`)

An outside process on a runner — a background worker that has to sign its results with the right
FLA, say — has no `graph-runtime.json` to read, and before this had to be told the space by hand
(rec#145). `fuli whoami` answers it, read only:

```bash
fuli whoami                      # the folder this runs in
fuli whoami --project <id|folder>
fuli whoami --json
```

It gives the personal space (ID and name), the project (ID and name) the folder resolves to, the
FLA leading that project (ID, its own name and its role), and whether this computer is the host or
a runner. It returns no token, no certificate and no address, enters no task and writes nothing to
knowledge. `--json` always has the same fields, `null` where there is nothing: `space`, `project`,
`lead`, `projectResolution`, `basis`, `computer.role`, `computer.hostReachable` (`null` on the
host), `offline` and `answeredAt`. A script should read `offline` (or the exit code): `0` answered
now, `3` the host's earlier answer, `2` no answer at all.

On a runner it goes through the console entry above, which relays it to the host console
(`POST /api/whoami`), and sends the folder's facts with it so the host resolves the folder by
exactly the rules in "Projects" below. While the host is away the host's last answer for that
folder is shown instead, marked `offline` with the time the host gave it; that answer is kept in
`whoami-last-answer.json` in the runner's data directory, holds only what the answer already shows,
and is one of the things `fuli runner leave` deletes. With no earlier answer for that folder it says
so and exits 2 rather than guess.

## Projects

Before a call that names a folder, the runner describes that folder: its real
path, the repository markers up the tree, the origin remote (credentials removed),
which children look like projects, and the README draft a new project would get.
The host answers path questions for that call from those facts
(`src/graphiti/caller-workspace.js`), so the ordinary resolver decides — same
remote matching, same worktree rules, same registration of a new repository —
without touching the host's disk. A folder the runner did not describe is
refused.

## When the host is away

Host diagnostic events (`read_diagnostic_events`) require a local client on the host.
A runner refuses this tool both online and offline. Opening an upgraded runner removes diagnostic
answers cached by earlier versions and keeps ordinary read-only answers.

| Call | Answer |
| --- | --- |
| Task entry (`begin_task_context`, `get_collaboration_preferences`) | The preferences the host last gave for that folder, marked offline, with a runner task token; nothing of the earlier task (its receipt, checkpoint duty or recall) |
| `checkpoint_task_knowledge` | Queued in the outbox (`queued_offline`); the answer says so and never claims it was saved |
| `resume_agent_conversation` | The recovery context the host last gave for that conversation, marked offline with when it was read, and the work logs of the checkpoints still waiting here (`undelivered_work`), saying how much was carried over. With neither, it says so and makes nothing up |
| `assess_agent_action`, `report_routing_outcome` on a runner whose Tonborg chooses executors | Answered on the runner, online or not (see "Executor judgment on a runner") |
| Other read-only tools | The last answer to the same call, marked offline, when there is one |
| Anything else | `host_unreachable`, saying the host must be reachable for it |

Every task entry on a runner carries `runner`, online as well as offline: online it names the host
that answered, offline it says the host is away, that FULI is still working from what is kept here,
and that nothing needs to be moved or set up again. A client's AI once read an offline entry as
"this computer has no FULI, the host must be migrated" and told the person so (rec#144).

A call that carries a runner task token while the host answers again goes to
the host: a checkpoint is queued behind what waits and delivered at once; the
call waits up to 20 seconds for that entry alone and answers `status:
delivered` only when the host applied it, `queued_offline` otherwise. A call
whose schema requires a task token needs a task the host entered: it answers
`offline_task_token`, saying to enter the task again, and sends nothing. That
is every tool whose input schema makes `taskContextToken` required, which is
most of the ones that act within a task — `resume_agent_conversation`,
`role_work`, `assess_task_completion`, `agent_chat`, `run_delegated_action`
and the rest — apart from `checkpoint_task_knowledge`, which is queued
instead. Any other call is sent without the token, which the host never knew.

The outbox is replayed oldest first whenever the host answers again (each MCP
process checks every 30 seconds; `fuli runner sync` replays at once); only the
oldest entry is ever being delivered, by one process at a time. A checkpoint
made under a runner task token is replayed under a new task entered on the host
for that folder; the original request is never stored.

Each checkpoint has an id, online too (in the call's `_meta`); one whose online
outcome is unknown (the connection dropped or timed out) is queued under that
same id. The host takes an id of that runner in the same transaction that
checks it, so it is applied once whichever delivery arrives first: a second
delivery while it is being applied is answered 409 and waits for the next
round, one after it gets the first answer. A runner waits up to three minutes
for a replay and never sends it again in the same round. The host holds an id
it is applying for as long as the longest call a runner waits for, and more (21
minutes); only a host that stopped in the middle of an entry applies it again,
as soon as it starts again. So a host process that crashed after applying a
checkpoint but before recording it applies that checkpoint twice; one console
per data directory makes this rare. Closing the runner's MCP process cuts a
delivery in flight; its entry stays queued.

When a call fails because the host ended the session or the connection
dropped, the runner asks `hello` at the addresses it knows (not over mDNS). If
the host answers (it only restarted), a read, a task entry (a second one only
supersedes the first) or a checkpoint (applied once under its entry id) is made
once more on a fresh session. A call that changes
something else is not repeated, since the host may already have run it: it
answers `outcome_unknown`, so the Agent checks with a read before trying again.
A call that timed out is never repeated.

## Executor judgment on a runner

The executors a runner can start are that computer's, so a runner may choose
among them itself: Tonborg's executor judgment (`assess_agent_action`) then runs
on the runner, with the runner's own model, whether or not the host answers.
Only that judgment moves. Knowledge review, task acceptance and every write to
knowledge or memory stay on the host, which remains the only store of the
person's knowledge; the runner's Tonborg never approves anything itself.

**Setting it up is the person's, on the runner.** Two files in the runner's
data directory, and the key:

- `model-backends.json`, the format the host's console saves
  (`src/model-backends/config.js`), with `roles.tonborg` enabled and
  `allowedOperations: ["executor_routing"]` only:

  ```json
  { "version": 1,
    "connections": { "flash": { "protocol": "anthropic_messages", "endpoint": "https://gateway.example/v1",
      "model": "deepseek-v4.1-flash", "secretRef": "runner-flash" } },
    "roles": { "tonborg": { "enabled": true, "connection": "flash", "allowedOperations": ["executor_routing"],
      "budget": { "maxTokensPerWindow": 2000000, "windowHours": 24 } } } }
  ```

  An enabled role needs a `budget` (its fields may be empty). A runner refuses a Tonborg role that also lists `knowledge_review` or
  `task_acceptance` (`runner_routing_config_invalid`), and no other role is
  ever called on a runner; the answer names the operations it does not take.
  A file this computer cannot read — broken JSON, a field of the wrong shape —
  answers `runner_routing_config_invalid` too, saying nothing was judged here
  and nothing was sent: a configuration of the person's that FULI cannot read
  is not quietly handed back to the host, which would look as if the runner
  were judging while it was not. What hands the judgment back is
  `model-backends.json` alone: fix it, or delete it (or its `roles.tonborg`)
  and the host judges again. A broken `runner/executors.json` is fixed in
  place; deleting it does not hand anything back, it only leaves no executor
  here, so Tonborg answers `ask_user`. `egress` is not read: setting this model up on the
  runner is the person's approval to send it what a judgment needs (below).
  `fuli models set-key <secretRef> --endpoint URL` saves the key on the runner,
  for that endpoint only; `fuli models check tonborg` tries the connection.
- `runner/executors.json`, the executors of this computer and the models each
  can run, which only the person writes (FULI never does):

  ```json
  { "version": 1, "executors": [
    { "executorId": "runner-codex", "displayName": "Codex on this runner", "client": "codex",
      "capabilities": ["coding", "review"],
      "models": [
        { "model": "gpt-5.6-luna", "strategyModes": ["fast", "balanced"], "costRank": 1 },
        { "model": "gpt-6.1-sol", "strategyModes": ["deep"], "costRank": 4, "note": "for hard bugs" } ] },
    { "executorId": "runner-cli", "displayName": "Another CLI agent", "client": "other", "command": "my-agent",
      "capabilities": ["coding"], "models": [ { "model": "deepseek-v4.1-flash", "costRank": 0 } ] } ] }
  ```

  `client` is one of FULI's client names (`codex`, `claude_code`, `cursor`,
  `opencode`, …, `other`); `command`, when given, is the command that starts
  it. Each judgment runs a local preflight first: an executor takes part only
  while its command (or the one FULI starts that client with) is found on this
  computer and it has every capability the task requires. A required capability
  that no executor declared here lists is refused at once as `invalid_input`,
  with the names there are, and nothing is judged. The host's executor
  directory is not read: its executors are another computer's.

Without `model-backends.json` naming such a role, `assess_agent_action` goes to
the host as before.

**What the judgment reads and sends.** The request as asked (ids, objective,
work kind, required capabilities, action), the executors that passed preflight
with their declared models, the ones left out and why, the preferences the host
last gave a task entry in that project (kept on the runner, see "What a runner
keeps"), and the runner's latest decisions in the project with the outcomes
reported for them. That is all its model receives; a task token never leaves the
runner. Tonborg's memory, the Agent's executor policies and allowed clients,
routing rules and earlier conversations live on the host and are not read here.

The preferences go as the host's own judgment sends them
(`src/judgment/preference-receipt.js`): each rule's key, scope, short text,
authority and where an inherited one comes from, never its reasoning or
attributes. They come from the task entry this computer kept for the
project. A real project's entry is often over the host's 32 KB delivery limit,
and the host then delivers it blocked (`preference_delivery.status: "blocked"`,
`preferences_complete: false`) with part of the rules or none; the runner
then reads the rest right away with the host's own reader
(`read_task_preferences`, page by page in one revision, joined as the host
joins them), in the same session that entered the task, as the reader
requires, and keeps the whole set for that entry; a judgment uses only the
read made for the project's latest entry, never an older entry's or another
Agent's. A revision that changes between pages starts the read over, once, and
a read that fails is written to the runner's diagnostics (`fuli diagnostics`,
operation `runner.preferences_read`). A judgment asked while its project's
read is still running waits for it at most 30 seconds, then stops and says the
read was still running; another project's judgment does not wait for it. The model port takes at
most 20,000 characters per part, and 70 rules of 200 characters already need
more than one, so every rule and conflict goes, in the host's order, across as
many parts as it takes, at most four: `preferences`, then `preferences_2` and
on, each saying it continues `preferences`, and the model is told that the
later parts' rules and conflicts apply as if listed in the first. As on the
host, Tonborg does not recommend when a rule may be missing: it answers
`ask_user` without calling the model when no task of the project was entered
on this computer while the host answered (evidence
`preference_delivery:unavailable`), when the kept entry was not delivered whole
and its rest could not be read, when the host's own read for it was cut, or
when four parts cannot hold every rule or a single rule is longer than a part
(`preference_delivery:partial`, naming that rule). Each says what the person
can do; removing `roles.tonborg` from `model-backends.json` on the runner
always has the host judge instead. Earlier decisions are only feedback,
so they are sent newest first as many as fit, and the rest counted
(`feedbackNotSent`). A request still too large to
send (an `executors.json` at its limits, say) is refused on the runner before
any model is called: `judgment_failed` with category `request_rejected` and
`rejected` naming the part, nothing spent.

**What it answers.** The same checks as on the host
(`src/judgment/routing.js`): the choice must be an executor and model it was
offered, and with no executor passing preflight the answer is `ask_user` with
no model call. No conversation of the host's is read here, so the model is
shown an empty list of them and `reuse_conversation` is never an answer it can
give. The tool is listed on a runner with what it does here, not with the
host's description. A record answers with `decidedOn: "runner"`, the `selection`
(executor, model, client), `leftOut`, the model's receipt, and the same
`requestId` gives the same decision again (two MCP processes answering one
`requestId` at the same moment keep the decision saved first; the one that
lost answers with it and says what its own model answer cost, unused, as
`unusedModelReceipt`). A model that
does not answer, a refusal, an exhausted budget or a choice that was not
offered fails the judgment (`judgment_failed` with the failure, and the
model's receipt whenever the model was called, so the caller sees that its
budget was spent); nothing falls back to the host or a session. It is a
recommendation: the caller starts the executor and records what really ran.

This computer must still be paired. Before it is, every call here answers
`runner_not_paired`, and after the host revokes it `runner_revoked`, including
`assess_agent_action` and `report_routing_outcome`: no model is called, nothing
is queued, and a store `fuli runner leave` deleted is not made again. The
pairing is checked again once the model has answered, so a leave or revoke
that lands meanwhile keeps nothing either; that answer carries
`unusedModelReceipt`.

**How a choice turned out.** When the chosen executor finished, the caller
reports it once with `report_routing_outcome` (`decisionId`, `vote` up or down,
`reason` from the real run). The runner lists that tool while its Tonborg is set
up; through `fuli_call` it is reached the same way. A second report of the same
decision answers `already_reported`. The next judgment on the runner reads it.

**To the host.** Each decision and each outcome is an outbox entry (kept in
`runner/routing.sqlite` too, until `fuli runner leave`), delivered
oldest first like a checkpoint and applied once per entry id. The host checks
the project as it does for a judgment of its own: a decision naming a project
this FULI does not have, or an archived one, is refused for good
(`project_not_found`) and stays listed as refused on the runner, where
`fuli runner status` shows the reason. The host keeps the
decision among Tonborg's routing records (`decidedOn: "runner"`, with the
runner's name and fingerprint), so Tonborg's workbench says which computer
judged it (an Agent's view carries `decidedOn` and the runner's name; the
fingerprint stays out, and a record with no `decidedOn` was judged on the
host), and
the outcome as that record's feedback marked `reportedBy: "runner:<fingerprint>"`,
never as the person's vote. Once the person has voted on a record, a runner's
report is kept in its feedback history but does not take their vote's place:
Tonborg's later judgments on the host read the person's. Bole's score card
counts FLA task outcomes the graph records, which these are not.

## What a runner keeps

The host's last answers to read-only calls, shown marked offline while the
host is away; the task tokens it gave out offline; checkpoints and executor
decisions waiting for the host, deleted once delivered (one the host refused
for good stays listed); and, when its Tonborg chooses executors, its decisions
and their outcomes. Beside them, the host's last `fuli whoami` answer per folder
asked about (`whoami-last-answer.json`, at most 20 folders): space, project and
lead FLA names and IDs, nothing else. It goes at `fuli runner leave` and when this computer joins a
host, and while the host has revoked this computer `fuli whoami` shows none of it.

**Nothing here is deleted because it is old** (rec#144, Jevons: 「保留 30 天这个没必要，就放着就可以」).
An answer is replaced when the host answers that call again; everything kept goes when the host
revokes this computer, when it joins another host, or at `fuli runner leave`. A follower that was
away from its host for a season still has the preferences it last read, and a checkpoint the host
refused stays listed until the person has dealt with it.

The cache has a size instead of an age: at most 5000 answers or 64 MB. Past either, the answers
used longest ago go first; an answer used lately stays however old it is. `/local` and
`fuli runner status` say how much is kept against those bounds.

A task token given out while the host is away lasts 30 days from its last use. It is not cached content: it names a
task in progress that the host never saw, and a task not continued for a month is not one anyone
continues, so a checkpoint under it would be replayed into a task context long gone. A checkpoint
under a token that is no longer valid is refused at once (`offline_task_expired`, enter the task
again), not queued for the host to refuse later; one queued while the token was valid keeps its
folder in the outbox and is delivered as before.

When the host answers that it does not know the runner (revoked, or a host
that lost its records), the runner deletes the answers and tokens, stops
looking for the host, answers every call `runner_revoked` (join again) and
keeps its waiting checkpoints, refused with `runner_revoked` and never retried.
After the host ended the runner's session the runner asks `hello` again
before it answers anything, so a revoked runner never answers from cache.
Joining the same host again (same certificate fingerprint) queues those
checkpoints again and delivers them; joining another host deletes them, and
`join` says how many were dropped. `fuli runner status` says when something
answers at the host's address with another certificate: if the host was
reinstalled, join again.

`fuli runner leave` deletes it all, the decisions made here included; with
checkpoints still waiting or refused
it says how many and needs `--force`, and so does a `join` to another host,
which would drop them (checked before the invitation is used). The clients' MCP entries stay (they then
answer that this computer is not paired); `fuli uninstall` removes them.
On Windows a client's FULI process that still has `runner/runner.sqlite` or
`runner/routing.sqlite` open keeps that file from being deleted: `leave`
empties it instead and says, file by file, what it could not delete, rather
than saying all was deleted.
`model-backends.json` and `runner/executors.json` are the person's own files,
so `leave` keeps them as they are and says so; they do nothing until this
computer joins a host again.

## Data format

Step 3a changes no store: `runner/local-runtime.json` is process state (the outcome of the last
preparation, see "This computer's own runtime"), and the follower's own graph is an ordinary FULI
graph made by the same setup as any first start. The copy of `global` changes no store either: it writes
the `replica` columns `runner/routes.sqlite` already had, and `runner/global-copy.json` is process state.

A runner whose Tonborg chooses executors adds `runner/routing.sqlite`
(`runner-routing`, version 1): its decisions and their reported outcomes, which
no longer expire. An older FULI does not open it. Its outbox entries use the tools
`runner_routing_decision` and `runner_routing_outcome`, which only a host of
this version takes; an older host refuses them (`entry_invalid`) and they stay
listed as refused.

Runners add two stores: `runner/host.sqlite`, which every 0.29.0-beta.1 host
created at console start, and `runner/runner.sqlite` on a runner. Version 1 is
what beta.1 shipped; this version migrates them on open, after the format
backup: `runner-host` 1 → 2 adds `runners.device_name`, 2 → 3 makes the
`replays` table again with its key per runner and the pending state (a
`replace-table` step: beta.1's replay records are not kept, as only an entry
still waiting on a runner is delivered again under its id); `runner` 1 → 2
adds `host.revoked_at`, 2 → 3 adds `host.last_seen_at` (when the host last
answered anything this computer asked, shown as 「上次连上」) and 3 → 4 adds
`answers.used_at` (when a kept answer was last used, so the cache lets go of the
answers used longest ago), and 4 → 5 adds `offline_tasks.used_at` (an offline task
token's 30 days count from its last use). Runners, pairings, invitations, answers and the outbox are kept. Every host's roundtable
store (`agent-roundtable.sqlite`) migrates from version 11 to 12 on the first
start of this version, whether or not it ever invites a runner: messages gain
`from_runner` (the runner that sent an ask) and `origin` (`runner` or
`remote` for an ask from another computer). The format backup is taken first,
as for every migration, and an older FULI then refuses that store.

## Project ownership on two computers

Open **Settings → Connections → Computers and project ownership** on the host. Choose all scopes or selected scopes when creating an invitation. An empty selection gives the runner no scopes. A runner can request a scope on its own local page. The host shows pending permissions and can allow or revoke each scope. Earlier full-access invitations retain their permissions.

The directory names the owner and the last successful copy. A verified local copy remains readable offline. Editing a project profile, loading its live Jefa board and reading the owner’s profile-change history require a connection to that owner. A naming conflict reserves the ID while the computers disagree about ownership.

To transfer, select the project and destination, enter the reason and start the transfer. Both computers must be reachable to finish. An interrupted transfer resumes with its original ID. Before the ownership decision, cancellation restores the previous owner once both participants acknowledge it. After the decision, the destination finishes installing the graph and board before it can write. To return the project, finish this transfer and start one in the other direction. A limited follower can offer its own project to the host. Start a transfer of a host-owned project on the host if the follower has only read permission for that scope.

The project graph, project-specific FLA memory, timeline and Jefa board travel together. Global FLA identities stay on the host. Start a new task at the new owner. Earlier task tokens remain bound to their issuing computer. Each computer retains the project-profile change log it recorded locally.

## Limits of this beta

A registered local project folder can have a different name from its project ID. A client's single-folder entry uses that recorded folder on this computer. Cursor sessions with several workspace roots lack a single project owner and use the host session introduction. A request containing a local project ID in a field with unknown scope can be refused, including when the ID is also a route word or search term.

- Runner and host must reach each other directly: the same LAN, a cable, or a
  VPN or mesh tool both are on (see "Two computers on different networks").
  FULI runs no relay, and will not.
- The prompt hook and the turn's end (Stop) of a folder that is not this
  computer's own project reach the host: the host enters the
  task at each prompt and, at the turn's end, checks its checkpoint and closes
  it, as a local hook would. A folder of this computer's own project runs every
  hook here, as on any FULI, its transcript kept here. The conversation's own text stays on the runner, so
  the host records no transcript of a runner's turns. The other lifecycle hooks
  do not run on a runner, and neither does the session switch
  (`/fuli start|stop|status`, `fuli session`): it needs a FULI on the same
  computer. While the host is away, every client's hook tells the model to
  enter the task through FULI's MCP server: Claude Code, Codex, OpenCode and
  DeepSeek Harness at each prompt, Cursor at session start (its prompt hook can
  only show text to the person). Cursor gives its MCP server no session, so its
  session-start instruction names Cursor's own session: the entry then gets a
  task token, which `resume_agent_conversation` and the checkpoint need.
- On Windows an ask from another computer (a runner's, or a paired device's)
  wakes only Claude Code, whose read-only wake has no shell; it never wakes
  Codex there, whose read-only sandbox is not verified to block the network on
  Windows. With no Claude Code to start, the ask is refused
  (`no_isolated_client`). On macOS and Linux both are woken.
- A runner on Windows has not been tried on a real second computer yet.
- A host that never invited a runner opens nothing for runners: no store, no
  listener, no mDNS, no timer. Closing either side releases its files, so
  updates and uninstall are not blocked on Windows.
- What is cached on the runner is what it last read; it is never merged back.
- The routes store is at format 2 since 0.29.0 (a project's folder); an earlier 0.29.0 beta cannot read it,
  so going back to one answers every call with `routes_unavailable` until FULI is updated again.
- A whole-graph backup of a follower is restored only to the computer that made it.
- A `leave` tried again within an hour reuses the copy the first attempt made when its size is unchanged:
  damage that keeps the size is not seen, and what was written in that hour is not in that copy.
