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
「最近你可能需要知道的事」, naming both and the fingerprint, so a pairing the
person did not make shows; a used invitation's error on the runner points at
`fuli runner list` and `fuli runner revoke`.

`join` then sets up the runner's clients exactly as `fuli setup` does (MCP entry,
Skills, Codex instructions), without starting a graph runtime. In runner mode the
same MCP command serves through the host, and lifecycle hooks do nothing: clients
enter tasks through the instructions and Skills instead.

`fuli runner leave` on the runner ends the pairing there: it deletes the runner
store (the host, the cached answers, offline task tokens and the outbox). The
host lists the runner until the person revokes it there.

## What a runner's call may do on the host

Every call a runner makes runs as that runner's, known by its certificate
fingerprint (`src/app/agent-request-context.js` `runAsRunnerCall`), and is held to
what a call from another computer may do:

- A wake of the person's Agents (`message_agent`, `agent_chat`, a group
  discussion) is read-only and loads only FULI's own MCP server, as a LAN
  roundtable ask from another computer is; it never goes to a desktop app
  conversation. The ask records the runner's fingerprint.
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
fingerprint while a runner is paired. The runner tries the address that answered
last, then the others it knows, then looks the fingerprint up over mDNS, taking
only private addresses from it. Any address is accepted only when it answers
with the pinned certificate. The listener closes a connection that has not
finished its TLS handshake in 10 seconds and holds at most 24 connections from
one address (64 in all). A company
network that isolates clients needs a cable or another shared network; no relay
is used.

## Projects

Before a call that names a folder, the runner describes that folder: its real
path, the repository markers up the tree, the origin remote (credentials removed),
which children look like projects, and the README draft a new project would get.
The host answers path questions for that call from those facts
(`src/runner/caller-workspace.js`), so the ordinary resolver decides — same
remote matching, same worktree rules, same registration of a new repository —
without touching the host's disk. A folder the runner did not describe is
refused.

## When the host is away

| Call | Answer |
| --- | --- |
| Task entry (`begin_task_context`, `get_collaboration_preferences`) | The last entry for that folder, marked offline, with a runner task token |
| `checkpoint_task_knowledge` | Queued in the outbox; the answer says so |
| Other read-only tools | The last answer to the same call, marked offline, when there is one |
| Anything else | `host_unreachable`, saying the host must be reachable for it |

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
for a replay and never sends it again in the same round. Only a host that
stopped in the middle of an entry applies it again, six minutes later.

## What a runner keeps

The host's last answers to read-only calls, shown marked offline while the
host is away and deleted after 30 days; the task tokens it gave out offline
(30 days); and checkpoints waiting for the host. Pairing with another host
deletes the answers and tokens of the old one. When the host answers that it
does not know the runner (revoked, or never paired there), the runner deletes
all of it, stops looking for the host and answers every call
`runner_revoked`: join again. `fuli runner leave` deletes it all.

## Limits of this beta

- Runner and host must reach each other directly (same LAN, cable, or a network
  both are on).
- Lifecycle hooks (automatic task entry and Stop checkpoints) do not run on a
  runner.
- What is cached on the runner is what it last read; it is never merged back.
