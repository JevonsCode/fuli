# Design: every FULI is a host, and follows another only where it says so

Status: proposal, not implemented. Builds on runners (`docs/runner.md`, PR fuli#1032).
Decisions marked **D1–D5** are Jevons's to make before any code.

## 1. Why

Runners today (0.29.0-beta.1) make a whole computer either a host or a runner. The switch is a
file: a data directory with `runner/runner.sqlite` and no `graph-runtime.json` is a runner
(`src/runner/runner-mode.js`). Three things follow, and the first two happened on a real pair of
computers on 2026-11-18:

1. **Opening FULI.app on a runner ends it being one.** The desktop start runs `fuli setup` when
   `graph-runtime.json` is missing (`src/desktop/desktop-controller.js`), which writes that file;
   the runner's clients then use a new, empty local FULI.
2. **A runner has no console of its own.** Receipt links (`127.0.0.1:2727`) open nothing on it.
3. **A runner cannot own anything.** The person wants project Y to live on B and project X on A,
   and B to keep working as its own FULI for what it owns.

The person's words: B "can switch itself between host and runner, even be partly one and partly
the other", and "the runner should also be able to be its own host".

## 2. The idea in one paragraph

Every FULI is a complete FULI with its own data and console, always. A link to another FULI (the
existing runner pairing: mutual TLS on port 2730, pinned certificates, outbox) no longer changes
what the computer *is*; it adds **routes**: a short table saying which parts of the person's FULI
this computer reads and writes on the other one. Everything without a route is local. A computer
with no routes is today's host; one that routes everything is today's runner; anything between is
"partly host, partly runner".

```
B's routes                       A's routes
  global      → A                  (none: A owns all it has)
  project X   → A
  project Y   → local (B owns it)
  (default)   → local
```

## 3. Scopes: what can be routed

| Scope | Holds | Notes |
| --- | --- | --- |
| `global` | the person's global preferences and habits, personal profile, FLA roster and their global memory, Jefa's board | one owner for the whole scope (**D1**) |
| `project:<id>` | a project's knowledge, project preferences, project memory of its FLAs, its tasks and checkpoints | routed one project at a time |
| default | whatever has no route | always `local` |

**Invariant: every scope has exactly one owner, the computer that writes it.** A follower never
writes a routed scope locally; it sends the call (or queues it in the outbox while the owner is
away). This is what keeps "partly host" from turning into two diverging copies.

## 4. How a call is routed

The client's MCP entry stays exactly what `fuli setup` writes today. The local MCP server always
runs (no more runner mode by file); for each call it decides where the call goes:

1. **Resolve the folder locally** with the facts the runner already sends (`workspace-facts.js`):
   which project is this folder, by the same rules (remote key, worktree origin, folder name).
2. **Look up the route** of that project (`project:<id>`, else default). Calls with no folder
   (global tools, `list_agent_interfaces`, roundtable) use the `global` route.
3. **Local route:** run it in this FULI as today. **Remote route:** forward it over the existing
   runner connection, with the folder's facts, exactly as runners do now; offline rules and the
   outbox apply unchanged.
4. **Task tokens remember their owner.** A token says which FULI issued it (prefix or a signed
   field), so the checkpoint of a task goes to the FULI that entered it, whatever the routes
   became meanwhile.

Task entry for a local project still needs the person's global preferences. If `global` routes to
A, task entry on B reads them from A (cached for offline, as runner task entry is today) and merges
them with B's project preferences, global first, project overrides, exactly as one FULI merges them
now (**D2**).

## 5. The console on a follower

- FULI.app on B opens B's own console. Projects B follows are listed with their owner
  ("X · on A"); opening one opens A's page **through the paired channel**: B serves a local proxy
  at `127.0.0.1:2727/remote/<host>/…` that forwards over 2730 mTLS. Receipt links issued by A carry
  the host, so they open on B too.
- The desktop start never removes a link and never writes a route; `fuli setup` on a computer
  with links sets up its runtime and keeps the routes.
- A host's console lists its followers and, per follower, which scopes it serves to it.

## 6. Who may route what

- Routing is granted on the owner: when B asks to follow `project:X` or `global`, A's person
  allows it (once, in A's console or `fuli runner allow`). Today's invitation keeps granting
  "everything" so existing runners keep working.
- A follower can always take a route back (`fuli routes local project:X`); see moving below.

## 7. Moving a scope between computers (D3)

Changing who owns a scope moves its data, which is the hard part. Proposed, in order of effort:

1. **Start a new route only for a scope the follower does not have yet** (beta): B follows
   project X only if B has no local project X, otherwise it asks the person to pick one.
2. **Hand over** (later): the owner exports the scope (FLA directories already have a Markdown
   projection for hand-off; knowledge as the existing export), the new owner imports it under
   the same IDs, the old owner keeps a read-only copy and a forwarding route. Temporal history
   moves with it.
3. Two owners merging edits of one scope: **not planned**. One owner per scope is the rule.

## 8. FLAs across two owners (D4)

An FLA is global (employee number in the personal space) but keeps per-project memory. With
`global` on A and project Y on B, Y's lead is one of A's FLAs, while Y's project memory is on B.
Proposal: the FLA's identity and global memory stay with `global`'s owner; its memory of a project
lives with that project's owner. Task entry on B for Y reads the FLA's identity from A and its Y
memory locally. If this is too much for a first version: a project owned by B gets one of **B's**
own FLAs until D4 is decided.

## 9. What changes in code (rough)

| Area | Change |
| --- | --- |
| `src/runner/runner-mode.js` | gone; replaced by a routes store (`runner/routes.sqlite`) |
| `src/cli/mcp-command.js` | always the local server; a router decides per call (runner modules loaded only when a route is remote) |
| `src/runner/runner-mcp.js` | becomes the remote half of the router |
| `src/graphiti/task-entry*` | global preferences from the `global` owner, merged with local project preferences |
| task tokens | carry their issuer |
| console | `/remote/<host>/` proxy; followed projects listed with their owner; host lists what it serves |
| desktop app | start/setup keep links and routes |
| CLI | `fuli routes list | follow <scope> <host> | local <scope>`; `fuli runner join` keeps working as "follow everything" |

## 10. Migration from beta.1

A data directory in today's runner mode (pairing, no runtime) becomes: a FULI with routes
`global → host` and `default → host`. Nothing to do for the person; the first start after the update
sets up the local runtime in the background, and nothing is routed to it until the person makes a
scope local.

## 11. Order of work

1. **Follower console and safe desktop start** (fixes §1.1 and §1.2 for today's runners).
2. Routes store, router in the MCP entry, tokens with issuer; `default → host` reproduces today.
3. Local projects on a follower (`project:Y → local`), global from the host (D1, D2).
4. Owner-side grants; console listing.
5. Moving a scope (D3), FLA split (D4).

## Decisions for Jevons

- **D1** Is `global` one scope with one owner, or may preferences and the FLA roster have
  different owners? (Proposal: one scope.)
- **D2** On a follower, do local projects use the host's global preferences (proposal) or the
  follower's own?
- **D3** Is moving a project between computers needed in the first version, or is "start a route
  only for a scope the follower does not have" enough? (Proposal: enough.)
- **D4** Who leads a project owned by the follower: the host's FLAs (memory split by project) or
  the follower's own FLAs?
- **D5** Version line: the runner work shipped as 0.29.0-beta.1; the agreed line is 0.27.x until
  1.0 (PR fuli#1032 review). Which line do runners and this design continue on?
