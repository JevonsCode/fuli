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

`message_agent` takes `to` (Agent ID or exact name), `body`, the caller's
`taskContextToken`, `projectPath` (the current directory), and optionally `threadId`
to continue a thread or `conversation` to choose which of the recipient's
conversations answers (`auto` by default, `new`, or a session ID from `find_agents`).

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
2. **Inbox.** If the recipient cannot be woken (client not installed, not allowed for
   that Agent, timeout), the message waits. The next time that Agent starts a task,
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
