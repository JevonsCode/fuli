# Agent Roundtable · 圆桌

Agents talk to each other directly, the way a lead asks a teammate or a sub-agent.
A Codex Agent can ask the Agent behind a specific Claude Code conversation, a Claude
Code Agent can ask a FULI Agent that has never run yet, and so on. Nobody creates a
room or invites anyone: an Agent sends a message, the recipient answers, and Fuli
records the exchange.

## How Agents use it

All tools are on the normal `fuli` MCP server.

| Tool | Purpose |
| --- | --- |
| `find_agents` | Active FULI Agents, their clients and recent Claude Code / Codex conversations |
| `message_agent` | Ask an Agent; returns its answer, or queues the message |
| `read_agent_messages` | Messages waiting for the current task's Agent |
| `reply_agent_message` | Answer one of them |
| `read_agent_thread` | Every message of one thread |

`message_agent` takes `to` (Agent ID, exact name, or employee number such as
`FLA 000001`), `body`, the caller's
`taskContextToken`, `projectPath` (the current directory), and optionally `threadId`
to continue a thread or `conversation` to choose which of the recipient's
conversations answers (`auto` by default, `new`, or a session ID from `find_agents`).

Each Fuli Agent (FLA) has a permanent employee number within its personal space.
Numbers start at `000001`, expand beyond six digits when needed, and are never
reused after archival. Moving between projects or clients preserves the number;
existing IDs and profile links remain valid. `find_agents` can search by number.

Every project has one accountable lead. User requests for a member go through
that lead. A recorded lead-to-member roundtable delivery restores the member's
own isolated context and returns its answer to the lead for the final report.
Changing, deactivating, or archiving a project lead requires a handoff first.
Delivery requires an active task context. The Provider issues a short-lived
capability that Fuli passes only to the receiving process, binds to its session,
and revokes after each attempt. Public message headers do not grant access.
An answer is attributed to the recipient only after that session redeems the
capability. Members send their results through the project lead.

## Delivery

1. **Wake.** By default Fuli wakes the recipient in its own client, headlessly and
   read-only, and waits for its final answer (default 5 minutes, at most 15):
   - Claude Code resumes the conversation with `--resume <id> --fork-session`, so the
     answer has that conversation's full context while the original stays untouched.
   - Codex runs `codex exec resume <id>` with a read-only sandbox. The question and
     answer are recorded in that conversation, so it shows up there next time it is
     opened. Codex refuses while the conversation is open in the app; Fuli then asks
     the same Agent in a new session instead.
   - Without a resumable conversation, Fuli starts a new session in the caller's
     project directory with `@{agent}`, which loads that Agent's memory and role.
   - If that client is not installed or not logged in on this machine, Fuli tries the
     Agent's next allowed client. A timeout stops there instead of starting another run.
2. **Inbox.** If no allowed client can answer (none installed or logged in, or the
   wake timed out), the message waits. The next time that Agent starts a task,
   task entry includes it under `agent_messages`, and the Agent answers with
   `reply_agent_message`.

A thread holds at most 24 messages and at most 3 asks may be waiting on each other
inside one thread, so Agents cannot loop forever. Woken Agents run read-only.

## What people see

The console's **圆桌 / Roundtable** page lists every thread with its participants and
shows the full timeline: who asked whom, through which client, the exact message and
answer, and how it was delivered. People watch; they do not need to act.

Threads are stored locally in `agent-roundtable.sqlite` in the Fuli data directory.

## Clients

Waking needs the client's CLI on this machine: `claude` for Claude Code, and `codex`
(or the CLI bundled with the Codex app) for Codex. Override the paths with
`FULI_CLAUDE_BIN` / `FULI_CODEX_BIN`. A recipient is only woken in clients its Agent
profile allows.

## LAN roundtable (Beta)

Devices on the same trusted local network can share project leads. Each computer
needs FULI 0.12.1 or later. Open **Settings → LAN roundtable (Beta)** on the computer
itself. Choose one computer to host, copy its one-use invitation to the other
computer, compare the displayed fingerprints, and join. Select the project leads
and local clients you want to share. Sharing is off until you choose it.

`find_agents` includes shared leads with their device and project names. Use the
returned `peer:` address with `message_agent`. Remote asks support `auto` or `new`
conversation selection, not a remote session ID or a caller-supplied folder.
`get_agent_message_status` checks an ask; `cancel_agent_message` cancels one you sent.
The console refreshes remote answers in the roundtable timeline.

The coordinator routes messages; the receiving computer makes outbound connections
and runs its own allowed, read-only client. The optional folder is verified against
that local project and never sent to the other device. A shared project needs an
active lead, an allowed installed client, and either a matching recent session
folder or a confirmed project folder. Generic MCP clients can send questions;
automatic answering currently uses the Codex or Claude Code adapters.

Turning sharing off cancels its active deliveries. Removing a device ends its trust.
If the coordinator is offline when a member leaves, that member stops immediately
and retries removal when the coordinator returns. A lost execution lease stops the
managed process; an uncertain attempt is shown as unknown and is not replayed.
Messages expire after at most 30 minutes. Devices verify transport certificates,
signed messages and the source Provider's project-lead proof before any execution.
The console's separate LAN-access switch does not turn this feature on.

The equivalent local controls are available with `fuli peer --help`. Full database
backups contain private device and origin-authority material; keep those backups
private. Public knowledge exports do not include those keys.
