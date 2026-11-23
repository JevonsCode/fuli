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
  refused when that FULI has it (`scope_has_local_data`). It asks the running FULI for the projects of
  this data directory's personal space and says apart a FULI it cannot reach
  (`local_fuli_not_running`), one that answered with an error (`local_fuli_refused`) and settings it
  cannot read (`local_fuli_unreadable`). Moving a scope between computers is a later step.
- `fuli routes local SCOPE` is refused (`local_route_not_yet`) until owning a scope on a computer
  that follows a host is built (the next step), whatever this computer has: a FULI of its own beside
  a pairing is normal, and a route written now would give that scope a second owner once the next
  step arrives. `global` is never routed to a follower (`global_has_one_owner`): habits, profile and
  the FLA roster have one owner, the computer it follows (D1, D2).
- Each call is routed before anything is sent: by the scope of the folder it names (`global`
  without one), or by the computer that entered the task its token names, so a checkpoint goes
  back to the computer that entered the task whatever the routes became. A call whose owner this
  computer cannot reach is refused with the command that fixes it, never sent to another computer:
  `scope_owner_not_paired`, `task_owner_not_paired`, and `scope_owned_here` (a scope routed to this
  computer, which nothing writes yet). When the routes themselves cannot be read (a newer FULI wrote
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

## The console on a runner

A runner has no knowledge of its own yet, but it has a console of its own: `fuli start` (and
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
- `fuli status`, `fuli stop`, `fuli restart` and `fuli open` manage this entry; FULI.app starts it
  and never runs `fuli setup` on a runner. `fuli setup` (and the setup `fuli update` runs) on a
  runner sets up its clients only. A runner never gets a graph runtime by accident.
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
host does not learn a runner's version — nothing in the pairing carries it — so the notice is on the
runner's side only.

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
  computer and it has every capability the task requires. The host's executor
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

## Limits of this beta

- Runner and host must reach each other directly: the same LAN, a cable, or a
  VPN or mesh tool both are on (see "Two computers on different networks").
  FULI runs no relay, and will not.
- The prompt hook and the turn's end (Stop) reach the host: the host enters the
  task at each prompt and, at the turn's end, checks its checkpoint and closes
  it, as a local hook would. The conversation's own text stays on the runner, so
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
