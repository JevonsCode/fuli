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
| `read_agent_messages` | Messages waiting for the current task's Agent, plus the person's new answers to its attention requests |
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

## Chat push and unread delivery (RT-1)

`agent_chat` keeps direct/group messages separate from execution asks. Its `wait`
action takes `taskContextToken`, `chatId`, optional `after` (default `0`), `limit`
(default `50`, maximum `100`), and `timeoutSeconds` (default `60`, maximum `300`).
It returns the same member-scoped page as `read`: `messages`, `nextAfter`,
`hasMore`, and the room header. Existing backlog returns immediately. A timeout
returns an empty page without advancing the cursor. Use `nextAfter` for the next
wait. Cancellation releases the subscription; membership, task, sharing and
pairing authority are checked again before returning new content.

SQLite remains authoritative. A post-commit native file notification wakes other
local MCP/console processes; waits do not scan on an interval or hold a database
transaction open. The existing `/api/project-agent-task-events` SSE also emits
`event: chat` with only `chatId` and `seq`. The console reads rooms after a signal
and after reconnection. Paired owner notifications use a durable cursor; a peer
transport failure leaves local task events connected. Transport retries back off;
they are separate from waiting for messages. Legacy execution-ask status refresh
and the existing remote execution supervisor retain their own lifecycle.

A private message or group `@{local:agentId}` / `@{peer:device:binding}` mention can
request the existing read-only wake path if that room has no active wait. Plain
`@name` text does not route a wake. Local delivery uses the Agent's existing
client authorization; cross-device delivery is restricted to explicitly shared
executable leads. A communication-only share receives inbox/wait messages only.

The worker receives a bounded unread snapshot with cursors and explicit omitted
content/truncation flags. Its communication restrictions remain in place, and its
answer uses the existing verified return path. Device signatures and chat proofs
do not substitute for an execution origin proof or delegation. Snapshot access
honors both sender and recipient admission boundaries. Per-message delivery
receipts advance only a contiguous target cursor, so a newer member cannot erase
older unread history it was not allowed to see. Durable execution claims keep
one wake active per Agent; subsequent rooms wait for completion notifications.
Unknown execution or unconfirmed cleanup keeps its safety hold.

## Group discussions (@FLG, rec#55)

This section is mode 2 (「在圆桌里分头回复」). Mode 1 (「在这个会话里一起看」, chosen at
the same confirmation) never reaches the roundtable: task entry hands the session a
read-only index of the members' context (`src/graphiti/group-member-context.js`)
and nobody is woken (docs/agent-conversations-and-collaboration.md).

`group_discussion` runs a moderated discussion on top of a `kind=group` chat. It
only carries out what the person typed in their chat: task entry records the
confirmed members and question (`recordGroupChoice`) and each `@FLG …`
follow-up (`requestGroupFollowUp`). `start` takes that confirmation's request ID
and runs it once; an unknown ID, another moderator or project, or a stopped
confirmation is refused, and members and question come from the record.
`follow_up` carries out the recorded follow-up once, to the confirmed members (or
the one named), never to whoever the chat holds now; a discussion has at most two
response rounds and five follow-ups. A woken (delegated) session cannot start or
continue one. The moderator is the current project task's Agent
(docs/agent-conversations-and-collaboration.md). A start refused for good (no
executor, no active member) ends the confirmation with that reason, and a
confirmation not started within ten minutes expires, so neither keeps the session
held. Accepted residual: confirmation and follow-ups are recorded from task-entry
input; a model that calls the entry tool itself can produce them within the same
caps (fixed members, each consumed once, two response rounds, five follow-ups),
and with no more authority than `message_agent`.

Each member turn is a real `message_agent` wake in a fresh session (no resume) of
the member's own allowed client. Claude Code discussion wakes deny file edits and the shell: they keep the
non-interactive mode and add `--disallowedTools Edit,Write,NotebookEdit,MultiEdit,Bash` (a deny rule wins over any allow rule). Codex runs in its `read-only` sandbox. The prompt holds the
question, the member's role line and 800-character excerpts of the other members;
the member's own FULI entry delivers its preferences and knowledge index. The
Provider issues and verifies a per-attempt delegation, and only a verified answer
is posted as that member, in the same transaction that settles its still-open
turn: an answer to a turn already stopped or failed is never posted. A member
without an installed executor fails at once with `no_executor`, a dismissed one
with `unavailable`, one woken elsewhere at that moment with `busy`; when no member
can be woken, nothing is created (`flg_no_executor`). An unanswered ask is
withdrawn so it does not wait in the member's inbox.

`stop` (or the person's `@FLG 结束` from any process) ends unsettled turns as not
replied and cancels wakes running in the runner's process. `summary` records the
moderator's summary, and FULI appends the members that did not reply so they are
never counted. Turn states (`invited`, `waiting`, `replied`, `failed`, `ended`) are
stored in the roundtable file (migration `roundtable/3-group-discussions`). Rounds
run in the process that started them, which writes a heartbeat every 20 seconds (a busy file is retried next time; a store moved underneath by an undo or restore ends the run, its open turns `interrupted`);
another process fails the open turns of a runner without a heartbeat for a minute
as `interrupted`, and never touches a live runner's turns. Members on other paired
devices are not supported.

The roundtable file moves to format 3 on upgrade. An older FULI refuses it (the
roundtable and chats are unavailable there), and restoring the pre-upgrade backup
drops the chats, discussions and messages written since the upgrade.

Local tests use synthetic Agent/project identities and loopback mTLS devices.
They verify protocol behavior, not real paired-computer acceptance or an actual
model/client run. Actual paired devices still need matching code, explicit owner
shares, fingerprint verification, and separate end-to-end acceptance.
