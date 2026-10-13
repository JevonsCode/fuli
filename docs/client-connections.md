# Connect a client

FULI works through standard MCP tool calls. A client's brand or model provider is
not an admission requirement. Installation and configuration generation do not
call a model. A model can help a user configure a client or diagnose an error,
but is never required to run the installer.

## Local connection

1. Install and initialize FULI with `npm install --global fuli-context` and
   `fuli setup`. Setup can finish even when no known client is installed. Use
   `fuli setup --skip-agents` to configure only FULI without changing any client.
2. Run `fuli connect`, or open **Settings → Client connection** in the console.
3. Merge the generated `fuli` entry into the client's MCP settings, keeping its
   other servers. Reload and trust the connection as required by that client.

The generated configuration launches a local stdio server using the current
Node executable and installed package. It contains paths, not credentials. It
is for this machine; regenerate it after moving the installation or changing
the Node location. Use `fuli connect --data-dir PATH` for a separate FULI data
directory, or `--runtime-config FILE` for an explicit runtime configuration.

`fuli connect --format vscode` uses VS Code's `servers` envelope.
`fuli connect --format server` prints only the server's `type`, `command` and
`args` for clients with their own configuration editor. Paths with spaces remain
individual JSON arguments; do not paste them as an unquoted shell command.

### Client status

**Settings → Client connection** also lists the supported local clients that
FULI found and whether their FULI integration configuration is still in place:
connected, changed, skills left without MCP, removed after an earlier
connection, not connected, or unknown when a client's config, settings, hooks or
their folder cannot be read or parsed. Only a missing file counts as removed. The view re-reads configuration on open, on manual refresh and every 15
seconds while the card is open and the page is visible. It only describes
configuration; it does not show whether a client is running or reachable, and it
never reinstalls anything. FULI keeps only the latest status and the last five
changes per client in `client-connection-observations.json` in its data
directory; if that file is damaged, the history starts over. If it cannot be
saved, the console keeps the history until FULI restarts and says it is unsaved.

## Claude Desktop and other chat apps

`fuli setup` detects Claude Desktop (Windows and macOS) and adds a `fuli` entry to
`claude_desktop_config.json`, keeping its other settings and servers and backing up the
file first. Quit and reopen Claude Desktop afterwards; it only reads the file at launch.

Chat apps load exposed tool schemas into each conversation, so Claude Desktop and
newly configured Claude Code connections get the **chat profile**
(`--tool-profile chat`): 21 initial tools for preferences, project knowledge,
recording, completion checkpoints, conversation recovery, the Roundtable and tool
discovery. `list_agent_interfaces` defaults to a schema-free directory. Request one
exact `toolName` to read its complete schema and expose that original named tool
through `tools/list_changed`, then call the original name under the client's normal
permissions. This also provides management, routing, publishing and recruitment on
demand; discovery grants no permission. If the client does not refresh its tool list,
reconnect using `fuli connect --profile full`. Generated full configuration keeps the
explicit `--tool-profile full` choice so managed upgrades preserve it. Legacy Claude
Code setup entries without an explicit profile migrate to chat; `alwaysLoad` remains
enabled for its initial tools. Claude Desktop conversations are attributed to `claude`.
For another chat-style client, print the same entry with
`fuli connect --profile chat --source-application claude` (or the matching source).

Claude Desktop has no lifecycle hooks, so task entry and the closing attribution line
depend on the Agent following FULI's instructions, and visible conversations are not
captured automatically.

The generated paths go through the active Node location (for example nvm's
`C:\nvm4w\nodejs`) rather than a versioned install folder, so switching Node
versions with a version manager does not break client configuration.

Clients that only ask for a command can use `fuli mcp` if `fuli` is on their PATH.
`fuli mcp --tools` lists the available tool contract without starting a task.
Configuration export is read-only: it neither modifies client settings nor
claims the client has connected successfully.

When a turn receives no valid Hook context, `get_collaboration_preferences` is
the task-entry fallback. Supply the actual native `sessionId` and current
`taskPrompt`; it returns a fresh `taskContextToken` for the final checkpoint and
recovers the selected role's latest saved result. Never guess a native ID or use
an MCP process ID. Without the native ID or prompt, preferences remain available
but `task_lifecycle.status=not_started` reports that checkpoint ownership was not
established. An unfinished Provider task is not evidence of Hook delivery.

Claude Code's blocked or unavailable entry output supplies the host's native ID
when available and directs the Agent to this fallback. Transcript ownership
guards stay intact: a fallback task-summary checkpoint does not prove that the
native transcript tail was captured or that the Hook delivered task context.
Hook execution, successful FULI entry and model receipt require separate evidence.

## What a compatible client needs

- MCP **tool discovery and invocation**, using stdio or the remote transport
  described below. A resource-only MCP viewer cannot run FULI workflows.
- Permission to connect to FULI and to use the relevant project and Agent.
- An Agent that receives and follows the server's task-entry and completion
  instructions. If the client omits MCP server instructions, add the installed
  FULI Skill or equivalent task instructions to that client's instruction field.

The generic connection uses the existing `other` client attribution and preserves
project, Agent and executor permissions. It does not impersonate a supported host.
To continue work, select the same FLA and authorized project against the same
accessible FULI data. FULI does not copy source files or native client tool state.

Verify a connection by checking that FULI tools appear, asking the Agent to load
the current project's context, completing a small task, and checking that the
same FLA can recover the saved result in a new conversation. Merely saving JSON
is not proof that task entry or completion ran.

## Optional client integration

| Capability | Generic MCP | Current dedicated adapters |
| --- | --- | --- |
| Tools, authorized preferences and working memory | Available through tool calls | Shared behavior |
| Automatic configuration and bundled instructions | Merge generated configuration | Codex, Claude Code, Cursor; Claude Desktop (configuration only, chat profile) |
| Task entry and completion hooks | Agent follows instructions; no guaranteed hook | Host-specific adapters; Cursor has a limited completion reminder |
| Automatic visible conversation capture | No | Supported Codex and Claude Code transcript formats |
| Roundtable wake/resume | Messages can wait for the recipient's next task | Codex and Claude Code CLIs |

VS Code/Copilot, Gemini CLI and Cline document compatible local MCP transports.
They are candidates for generic connection, not a claim of completed FULI
end-to-end acceptance. Other MCP clients and custom Agents can use the same
contract. Closed chat interfaces without tools or an extension interface cannot
connect directly.

New dedicated adapters belong behind the shared client ports. They should add
only host-specific configuration, hooks, transcript parsing or execution, never
a second version of FULI's knowledge and role rules. Missing enhancements must
remain explicit; a generic connection must not claim automatic capture or wake.

## Remote clients

FULI includes a project-bound Streamable HTTP MCP upstream via `fuli remote-mcp`.
It is separate from the console at port 2727. Cloud clients cannot reach a user's
loopback address. They need a reachable HTTPS endpoint with authentication and
the allowed project scope. The current upstream binds to loopback and requires
an authenticated proxy for cloud use; it is not a turnkey public service.
See the [remote connector setup](../README.md#remote-claude--cowork-connector-upstream).

## References

- [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Cline MCP connections](https://docs.cline.bot/mcp/mcp-overview)
