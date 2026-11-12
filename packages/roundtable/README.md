# fuli-roundtable

Agents in Claude Code and Codex find each other, ask each other questions, and chat, on one computer or across computers paired on a local network. When one Agent asks another, the other is woken read-only in its own client and folder, and its answer comes back to the asker. Every exchange is kept locally.

This package runs on its own. FULI uses the same package and adds memory, projects and a console on top.

## Quick start (one computer)

Requires Node.js 24.12 or later.

```sh
# Register one Agent per folder
fuli-roundtable agent add --name Rowan --folder ~/code/billing --clients claude_code,codex
fuli-roundtable agent add --name Asker --folder ~/code/app --clients claude_code

# Connect your clients (prints the command; --yes runs it)
fuli-roundtable setup --client claude_code
fuli-roundtable setup --client codex
```

In a Claude Code or Codex session started in `~/code/app`, ask the model to use `find_agents` and `message_agent` to ask Rowan something. Rowan is woken in `~/code/billing` and answers.

The calling Agent is the one registered for the session's folder. A woken session can only read and answer; it cannot ask further questions.

## Two computers

Keep the service running on each computer:

```sh
fuli-roundtable serve
```

On the same network, turn nearby pairing on on both computers. Each then sees the other by name and short fingerprint; this tells the devices on that network that the computer runs FULI.

```sh
fuli-roundtable peer nearby on --name Desk
fuli-roundtable peer nearby
fuli-roundtable peer pair <fingerprint from the list>
```

Both computers then show the same 6-digit code. On each computer, compare it with the other screen and confirm with the code shown there. A request nobody confirms ends after 2 minutes.

```sh
fuli-roundtable peer confirm <code shown on the other computer>
```

Without nearby pairing, host and invite on the first computer:

```sh
fuli-roundtable peer host --address <this computer's LAN address> --name Desk
fuli-roundtable peer invite
```

On the second computer, join with that invitation. Before joining, check that the fingerprint matches the one the first computer showed.

```sh
fuli-roundtable peer join --invitation-file invite.txt --name Laptop
```

Each owner then chooses which Agents to share. Nothing is shared by default.

```sh
fuli-roundtable peer share --agent Rowan --clients claude_code
```

Shared Agents appear under `remoteAgents` in `find_agents`. Connections between the computers use mutual TLS, and every cross-computer ask carries an origin signed by the sending computer.

## Data

Everything lives in `~/.fuli-roundtable`. Set `FULI_ROUNDTABLE_HOME` or pass `--home DIR` to use another folder.
