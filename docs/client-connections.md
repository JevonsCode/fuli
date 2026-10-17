# Connect a client

After [install and setup](../README.md#start-here), connect one MCP-capable client, verify that a
Fuli tool call actually succeeds, and use the recovery table below if anything fails. A client's
brand or model provider is not an admission requirement. Installation and configuration generation
do not call a model. A model can help configure a client or diagnose an error, but is never
required to run the installer.

Local-first Fuli keeps Graphiti / Neo4j on this machine. Humans retain login, Hook trust, and
manual review. **Settings showing `Connected` (`connected`) only means the current Fuli entry is
present in the client's configuration file — it does not prove that the client loaded the MCP
process, that a Hook delivered context, or that a tool call succeeded.**

## 1. Connect

1. Finish `npm install --global fuli-context` and `fuli setup` (or `fuli setup --skip-agents` if
   you only want local Fuli services without editing any client). Setup can finish even when no
   known client is installed.
2. Prefer automatic setup when Codex, Claude Code, Cursor, or Claude Desktop is detected. For any
   other MCP client, run `fuli connect`, or open **Settings → Client connection** in the console.
3. Merge the generated `fuli` entry into the client's MCP settings while keeping its other servers.
   Reload and trust the connection as required by that client. Quit and reopen apps that read MCP
   configuration only at launch, then open a new task so the new MCP process loads.

```bash
fuli connect
fuli connect --format vscode
fuli connect --format server
fuli connect --profile chat --source-application claude
fuli connect --data-dir PATH
```

`fuli connect` prints local MCP JSON only; it neither modifies client settings nor claims that the
client connected successfully. Paths with spaces remain individual JSON arguments (do not paste
them as an unquoted shell command). Regenerate the snippet after moving the installation or
changing the Node location. Use `--data-dir PATH` for a separate Fuli data directory, or
`--runtime-config FILE` for an explicit runtime configuration (not both). `--format vscode` uses
VS Code's `servers` envelope; `--format server` prints only `type`, `command`, and `args`.

Clients that only ask for a command can use `fuli mcp` if `fuli` is on their `PATH`.
`fuli mcp --tools` lists the available tool contract without starting a task.

### Client status in Settings

**Settings → Client connection** lists supported local clients that Fuli found and whether their
Fuli integration configuration is still in place: **Connected** (`connected`, current Fuli entry in
config), **Configuration changed** (`changed`, Fuli entry present but differs from this version),
**Skills only** (`skills_left`, Fuli MCP entry gone and only skill files remain), **Removed**
(`removed` after an earlier connection), **Not connected** (`not_connected`), **Not found**
(`not_detected`), or **Cannot confirm** (`unknown`) when a client's config, settings, hooks, or
their folder cannot be read or parsed. Only a missing file counts as **Removed** (`removed`). The
view re-reads configuration on open, on manual refresh, and every 15 seconds while the card is open
and the page is visible. It describes **configuration files only** — it does not prove that a
client process is running, reachable, or able to invoke tools, and it never reinstalls anything
automatically. Fuli keeps only the latest status and the last five changes per client in
`client-connection-observations.json` in its data directory; if that file is damaged, history
starts over, and if it cannot be saved, the console keeps history until restart with an unsaved
notice.

## 2. First actual tool call and verification

1. Run `fuli status` — the management UI and personal graph should report ready (default
   `http://127.0.0.1:2727`).
2. Confirm that Fuli tools appear in the client's tool list.
3. Inside a project directory, ask the Agent to make an **actual Fuli tool call** (for example,
   load current project collaboration preferences or coordinate a small task) and verify that it
   resolves the right project and asks for missing context instead of inventing it.
4. Optional cross-client handoff: continue the same FLA in another client connected to the same
   accessible data using its continuation instruction, and verify that it recovers the saved result.

Merely saving JSON or seeing **Connected** (`connected`) in Settings is not proof that task entry,
Hook delivery, or completion checkpoints ran.

When a turn receives no valid Hook context, `get_collaboration_preferences` is the task-entry
fallback. Supply the actual native `sessionId` and current `taskPrompt`; it returns a fresh
`taskContextToken` for the final checkpoint and recovers the selected role's latest saved result.
Never guess a native ID or use an MCP process ID. Without the native ID or prompt, preferences
remain available but `task_lifecycle.status=not_started` reports that checkpoint ownership was not
established. An unfinished Provider task is not evidence of Hook delivery.

Claude Code's blocked or unavailable entry output supplies the host's native ID when available and
directs the Agent to this fallback. Transcript ownership guards stay intact: a fallback
task-summary checkpoint does not prove that the native transcript tail was captured or that the
Hook delivered task context. Hook execution, successful Fuli entry, and model receipt require
separate evidence.

## Claude Desktop and other chat apps

`fuli setup` detects Claude Desktop (Windows and macOS) and adds a `fuli` entry to
`claude_desktop_config.json`, keeping its other settings and servers and backing up the file first.
Quit and reopen Claude Desktop afterwards; it only reads the file at launch.

Chat apps load exposed tool schemas into each conversation, so Claude Desktop and newly configured
Claude Code connections get the **chat profile** (`--tool-profile chat`): 21 initial tools for
preferences, project knowledge, recording, completion checkpoints, conversation recovery, the
Roundtable, and tool discovery. `list_agent_interfaces` defaults to a schema-free directory.
Request one exact `toolName` to read its complete schema and expose that original named tool
through `tools/list_changed`, then call the original name under the client's normal permissions.
This also provides management, routing, publishing, and recruitment on demand; discovery grants no
permission. If the client does not refresh its tool list, reconnect using
`fuli connect --profile full`. Generated full configuration keeps the explicit `--tool-profile
full` choice so managed upgrades preserve it. Legacy Claude Code setup entries without an explicit
profile migrate to chat; `alwaysLoad` remains enabled for its initial tools. Claude Desktop
conversations are attributed to `claude`. For another chat-style client, print the same entry with
`fuli connect --profile chat --source-application claude` (or the matching source).

Claude Desktop has no lifecycle hooks, so task entry and the closing attribution line depend on
the Agent following Fuli's instructions, and visible conversations are not captured automatically.

The generated paths go through the active Node location (for example nvm's `C:\nvm4w\nodejs`)
rather than a versioned install folder, so switching Node versions with a version manager does not
break client configuration.

## What a compatible client needs

- MCP **tool discovery and invocation**, using stdio or the remote transport described below. A
  resource-only MCP viewer cannot run Fuli workflows.
- Permission to connect to Fuli and to use the relevant project and Agent.
- An Agent that receives and follows the server's task-entry and completion instructions. If the
  client omits MCP server instructions, add the installed Fuli Skill or equivalent task
  instructions to that client's instruction field.

The generic connection uses the existing `other` client attribution and preserves project, Agent,
and executor permissions. It does not impersonate a supported host. To continue work, select the
same FLA and authorized project against the same accessible Fuli data. Fuli does not copy source
files or native client tool state.

## Optional client integration

| Capability | Generic MCP | Current dedicated adapters |
| --- | --- | --- |
| Tools, authorized preferences and working memory | Available through tool calls | Shared behavior |
| Automatic configuration and bundled instructions | Merge generated configuration | Codex, Claude Code, Cursor; Claude Desktop (configuration only, chat profile) |
| Task entry and completion hooks | Agent follows instructions; no guaranteed hook | Host-specific adapters; Cursor has a limited completion reminder |
| Automatic visible conversation capture | No | Supported Codex and Claude Code transcript formats |
| Roundtable wake/resume | Messages can wait for the recipient's next task | Codex and Claude Code CLIs |

VS Code/Copilot, Gemini CLI and Cline document compatible local MCP transports. They are
candidates for generic connection, not a claim of completed Fuli end-to-end acceptance. Other MCP
clients and custom Agents can use the same contract. Closed chat interfaces without tools or an
extension interface cannot connect directly.

Capture can be turned off per client (`disabledSources` in the capture policy, or the per-client switches in Settings). A client that is off keeps its tools and can still read existing memory; it only stops adding new conversations, knowledge candidates and working memory. The global switch still turns capture off for every client.

New dedicated adapters belong behind the shared client ports. They should add only host-specific
configuration, hooks, transcript parsing, or execution, never a second version of Fuli's knowledge
and role rules. Missing enhancements must remain explicit; a generic connection must not claim
automatic capture or wake.

## Common failure recovery

| Symptom | What to try |
| --- | --- |
| Node.js below 24.12 | Upgrade Node.js to 24.12+, then rerun `fuli setup` |
| Docker / Compose missing or engine stopped | Start the container runtime, then rerun `fuli setup` |
| Port busy or setup stops early | Resolve the reported port or runtime conflict; setup stops before modifying Agent configs |
| Settings shows **Connected** (`connected`), but tools are missing or a call fails | Reload and trust the MCP server in the client; quit and reopen apps that read config only at launch; open a new task |
| Codex Hooks not running or exit with untrusted notice | Review and trust the Hooks in Codex with `/hooks` (setup never bypasses host trust) |
| Settings shows **Configuration changed** (`changed`) or **Connected** (`connected`) after an upgrade | Run `fuli setup --yes --connected-only` to refresh clients that still have a Fuli MCP entry in their config |
| Settings shows **Skills only** (`skills_left`), **Removed** (`removed`), **Not connected** (`not_connected`), or client is newly installed | Run a full `fuli setup`. `--connected-only` skips clients without a Fuli MCP entry and leaves existing Skills unchanged |
| Unsure whether local UI / graph services are running | Run `fuli status` (and `fuli start` or `fuli restart` if stopped) |

## Remote clients

Fuli includes a project-bound Streamable HTTP MCP upstream via `fuli remote-mcp`. It is separate
from the console at port 2727. Cloud clients cannot reach a user's loopback address. They need a
reachable HTTPS endpoint with authentication and the allowed project scope. The current upstream
binds to loopback and requires an authenticated proxy for cloud use; it is not a turnkey public
service. See the [remote connector setup](../README.md#remote-claude--cowork-connector-upstream).

## References

- [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Cline MCP connections](https://docs.cline.bot/mcp/mcp-overview)
