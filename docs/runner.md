# Runners · 运行机

A runner is another computer of the same person that runs Agent clients (Codex,
Cursor, company Agents, any client that speaks MCP and loads Skills) while their
knowledge, preferences, FLAs and memory stay in **one** FULI, on the host
computer. Every runner thinks with its own clients; only what it reads and writes
of FULI goes to the host.

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
「最近你可能需要知道的事」, naming both and the command that revokes it
(`fuli runner revoke <fingerprint>`, as the console has no runner page), so a
pairing the person did not make shows; a used invitation's error on the runner
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

## The console on a runner

A runner has no FULI of its own, but it has a console entry: `fuli start` (and FULI.app's start)
runs `fuli runner console`, which listens on this computer's loopback at its usual console port
(2727 unless Settings say otherwise) and shows the host's console. Each request goes over the paired
mutual-TLS channel to `/runner/1/console/…` on the host, which forwards it to its own console on
loopback (`src/runner/console-relay.js`), so pages, API calls and live event streams behave as on
the host, and the receipt links the host gives (`http://127.0.0.1:2727/…`) open on the runner too.

- The entry answers only on loopback under its own name (no DNS rebinding) and refuses any other
  site's `Origin` before the channel; the host then gives the runner's own page the console's
  origin. The host keeps the runner's identity when forwarding to loopback. Pairing, host
  software updates and repairs, old installation data and detailed diagnostics belong to the
  host console. The runner can still read the public version at `/api/system/version`.
- 客户端接入 (`/api/system/client-connection…`) answers on the runner itself: it lists, connects,
  restarts and adds this computer's clients, with the same entries `fuli runner join` writes.
  Nothing of it reaches the host. The host's relay refuses those writes, and opening a session
  (`/api/session-launch`), with 403 `host_computer_only`, so a runner never changes the host
  computer's clients.
- While the host is away the entry shows a page saying so, with what waits in the outbox; API
  calls answer 503 `host_unreachable`. A revoked runner's entry reaches nothing.
- `fuli status`, `fuli stop`, `fuli restart` and `fuli open` manage this entry; FULI.app starts it
  and never runs `fuli setup` on a runner. `fuli setup` (and the setup `fuli update` runs) on a
  runner sets up its clients only. A runner never gets a graph runtime by accident.
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

## Finding the host again

The host listens on its private LAN addresses and follows them as they change
(checked every minute), and advertises `fuli-runner` over mDNS with its
fingerprint while a runner is paired. The runner tries every address it knows at
once (2.5 seconds in all), then looks the fingerprint up over mDNS (up to 3
seconds, done at the first answer), taking only private addresses from it. Any
address is accepted only when it answers with the pinned certificate. The
listener closes a connection that has not finished its TLS handshake in 10
seconds and holds at most 24 connections from one address (64 in all). A client
waits for the tool list when its MCP server starts: when the host has not
answered within 4 seconds the runner answers with the list the host last gave,
and tells the client to list again once the host's differs. A company
network that isolates clients needs a cable or another shared network; no relay
is used.

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
| `assess_agent_action`, `report_routing_outcome` on a runner whose Tonborg chooses executors | Answered on the runner, online or not (see "Executor judgment on a runner") |
| Other read-only tools | The last answer to the same call, marked offline, when there is one |
| Anything else | `host_unreachable`, saying the host must be reachable for it |

A call that carries a runner task token while the host answers again goes to
the host: a checkpoint is queued behind what waits and delivered at once; the
call waits up to 20 seconds for that entry alone and answers `status:
delivered` only when the host applied it, `queued_offline` otherwise. Any
other call is sent without the token, which the host never knew.

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
  ever called on a runner. `egress` is not read: setting this model up on the
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

**What it answers.** The same checks as on the host
(`src/judgment/routing.js`): the choice must be an executor and model it was
offered, and with no executor passing preflight the answer is `ask_user` with
no model call. A record answers with `decidedOn: "runner"`, the `selection`
(executor, model, client), `leftOut`, the model's receipt, and the same
`requestId` gives the same decision again. A model that does not answer, a
refusal or an exhausted budget fails the judgment (`judgment_failed` with the
failure and receipt); nothing falls back to the host or a session. It is a
recommendation: the caller starts the executor and records what really ran.

**How a choice turned out.** When the chosen executor finished, the caller
reports it once with `report_routing_outcome` (`decisionId`, `vote` up or down,
`reason` from the real run). The runner lists that tool while its Tonborg is set
up; through `fuli_call` it is reached the same way. A second report of the same
decision answers `already_reported`. The next judgment on the runner reads it.

**To the host.** Each decision and each outcome is an outbox entry (kept in
`runner/routing.sqlite` too, 30 days, deleted by `fuli runner leave`), delivered
oldest first like a checkpoint and applied once per entry id. The host keeps the
decision among Tonborg's routing records (`decidedOn: "runner"`, with the
runner's name and fingerprint), so the person sees it in Tonborg's workbench, and
the outcome as that record's feedback marked `reportedBy: "runner:<fingerprint>"`,
never as the person's vote. Tonborg's later judgments on the host read it with
its other feedback. Bole's score card counts FLA task outcomes the graph
records, which these are not.

## What a runner keeps

The host's last answers to read-only calls, shown marked offline while the
host is away and deleted after 30 days; the task tokens it gave out offline
(30 days); checkpoints and executor decisions waiting for the host, deleted once
delivered (one the host refused for good stays listed for 30 days); and, when
its Tonborg chooses executors, its decisions and their outcomes (30 days).

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

`fuli runner leave` deletes it all; with checkpoints still waiting or refused
it says how many and needs `--force`, and so does a `join` to another host,
which would drop them (checked before the invitation is used). The clients' MCP entries stay (they then
answer that this computer is not paired); `fuli uninstall` removes them.

## Data format

A runner whose Tonborg chooses executors adds `runner/routing.sqlite`
(`runner-routing`, version 1): its decisions and their reported outcomes. An
older FULI does not open it. Its outbox entries use the tools
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
adds `host.revoked_at`. Runners, pairings, invitations, answers and the outbox
are kept. Every host's roundtable
store (`agent-roundtable.sqlite`) migrates from version 11 to 12 on the first
start of this version, whether or not it ever invites a runner: messages gain
`from_runner` (the runner that sent an ask) and `origin` (`runner` or
`remote` for an ask from another computer). The format backup is taken first,
as for every migration, and an older FULI then refuses that store.

## Limits of this beta

- Runner and host must reach each other directly (same LAN, cable, or a network
  both are on).
- The prompt hook and the turn's end (Stop) reach the host: the host enters the
  task at each prompt and, at the turn's end, checks its checkpoint and closes
  it, as a local hook would. The conversation's own text stays on the runner, so
  the host records no transcript of a runner's turns. The other lifecycle hooks
  do not run on a runner, and neither does the session switch
  (`/fuli start|stop|status`, `fuli session`): it needs a FULI on the same
  computer. While the host is away, every client's hook tells the model to
  enter the task through FULI's MCP server: Claude Code, Codex, OpenCode and
  DeepSeek Harness at each prompt, Cursor at session start (its prompt hook can
  only show text to the person).
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
