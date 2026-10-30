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
| Automatic configuration and bundled instructions | Merge generated configuration | Codex, Claude Code, Cursor, OpenCode 2.x; Claude Desktop (configuration only, chat profile) |
| Task entry and completion hooks | Agent follows instructions; no guaranteed hook | Host-specific adapters; Cursor has a limited completion reminder; OpenCode 2.x through a FULI plugin (entry as system text each turn, close after a successful execution) |
| Automatic visible conversation capture | No | Supported Codex and Claude Code transcript formats (not OpenCode yet: it keeps no transcript file) |
| Roundtable wake/resume | Messages can wait for the recipient's next task | Codex and Claude Code CLIs |

VS Code/Copilot, Gemini CLI and Cline document compatible local MCP transports. They are
candidates for generic connection, not a claim of completed Fuli end-to-end acceptance. Other MCP
clients and custom Agents can use the same contract. Closed chat interfaces without tools or an
extension interface cannot connect directly.

Capture can be turned off per client (`disabledSources` in the capture policy, or the per-client switches in Settings). A client that is off keeps its tools and can still read existing memory; it only stops adding new conversations, knowledge candidates and working memory. The global switch still turns capture off for every client.

For compatibility (rec#11 D-64), a stored list containing `other` also covers `opencode`, which previously used that source. Turning OpenCode capture on keeps `other` in `disabledSources` and adds `opencode` to the optional `capturedSources` list: this overrides the legacy alias for OpenCode alone, leaving Gemini CLI, Qwen Code and generic MCP clients off. Turning OpenCode off removes that override and lists it in `disabledSources`; an explicit disabled entry always wins. Allowed-client profiles use the same legacy coverage rule. Capture policy files remain at format version 1 (or 2 for project modes): older readers build the policy field by field and ignore unknown fields, so they ignore `capturedSources` and keep the legacy capture restriction.

New dedicated adapters belong behind the shared client ports. They should add only host-specific
configuration, hooks, transcript parsing, or execution, never a second version of Fuli's knowledge
and role rules. Missing enhancements must remain explicit; a generic connection must not claim
automatic capture or wake.

## Shared client components

Two components FULI shares with other products recognize clients, open their sessions and install
into them (rec#11 D-79): [agent-session-launcher](https://github.com/JevonsCode/agent-session-launcher)
and [agent-installer](https://github.com/JevonsCode/agent-installer). FULI runs each as a pinned
native executable through its own ports (`src/agent-kits/session-launcher.js`,
`src/agent-kits/client-installer.js`); their Node bindings are vendored unchanged under
`src/agent-kits/vendor/`. This first stage changes nothing a person sees, except as noted below:

- **Session links.** Settings → conversation launchers are written as the launcher's host
  configuration (`agent-kits/launcher.json` in the data directory, one `fuli-<application>` deep-link
  client per template the launcher can express) whenever the settings are read or saved. Before a
  knowledge record shows 「打开会话」, the console asks `GET /api/session-launch/offers`, which uses
  the launcher's `clients` and `inspect`. The link itself is the same href as before. Differences:
  an `any` ID format is the launcher's `safe` format (letters, digits, `.`, `_`, `:`, `-`), so a
  session ID with other characters gets no link. A template the launcher cannot express (for
  example `https://…`), a missing launcher or a failed request keeps FULI's own rules. Nothing
  opens a client yet: no route calls the launcher's `open`.
- **Which Claude client.** Claude Code's hooks read `CLAUDE_CODE_ENTRYPOINT` (`cli`,
  `claude-desktop`, …) and record, once per session, the launcher's client ID
  (`claude-code`, `claude-desktop` or the ambiguous `claude-code-unknown`) in
  `session-clients/` in the data directory. A hook never downloads the launcher; without one the
  label and entry point are kept and the console classifies them later. Sessions recorded before
  this have no record and are classified from their source application alone.
- **Installer status in shadow.** The console runs the installer's read-only `status` against
  FULI's product manifest (`src/agent-kits/fuli-installer-manifest.json`, composed into
  `agent-kits/fuli-installer.json`) beside FULI's own inspection, at most every ten minutes and
  never in the doctor's way. Per-client agreement is in the doctor report's `internal.installerShadow`
  (state codes only); the doctor's items and overall are unchanged. FULI's own writers still set
  up every client.

**Where the executables come from**, first match wins: the developer override
`FULI_AGENT_SESSION_LAUNCHER` / `FULI_AGENT_INSTALLER` (an absolute path), the Windows portable or
tray bundle (`runtime/agent-kits/*.exe`, listed under `agentKits` in `native-bundle.json` and in the
portable and tray inventories), then a copy downloaded into `native-runtime/agent-kits/` of the data
directory the first time the console needs it (never at import time, never from a hook). Downloads
use the pinned URL and are published only after their SHA-256 matches the pin; a copy that no longer
matches is refused, not replaced. Offline or on a platform without a release asset the component is
unavailable and FULI keeps its own behaviour.

**Bumping a component.** Release the component, then in one change: copy the new tag's
`bindings/node/index.mjs`, `index.d.ts` and `LICENSE` into `src/agent-kits/vendor/<component>/` and
update that README's tag and commit; set `version` and every platform's SHA-256 in
`src/agent-kits/pins.js` from the release's `SHA256SUMS`; run `test/agent-kits/` (the pin, bundle,
launcher and shadow tests download and verify the new assets).

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

## 自动发现与一键接入

在设置 → 客户端接入展开“本机客户端”，点击已检测客户端的“接入”。操作只在运行控制台的本机可用：先备份已有配置，再安装并自检，成功后需重启客户端。客户端自己的信任/启用步骤仍由客户端提示；配置自检不代表 MCP 已成功运行。失败或部分完成时，可重试或运行 `fuli setup` 查看详细原因。

| 客户端 | 全局配置 | 官方格式 |
| --- | --- | --- |
| Gemini CLI | `~/.gemini/settings.json` | [`mcpServers`，command + args](https://geminicli.com/docs/tools/mcp-server/) |
| Qwen Code | `~/.qwen/settings.json` | [`mcpServers`，command + args](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) |
| OpenCode | `~/.config/opencode/opencode.json` 或 `.jsonc`（支持 `XDG_CONFIG_HOME`） | [`mcp`，type=local，command 数组](https://opencode.ai/docs/mcp-servers/) |
| Kiro | `~/.kiro/settings/mcp.json` | [`mcpServers`，command + args](https://kiro.dev/docs/mcp/configuration/) |

新接入使用 chat 工具配置，已有显式 profile 会保留。一键接入 Cursor 也会补上 chat；旧 CLI Cursor 配置仍兼容。现有 Codex、Claude Code、Cursor 的生命周期/技能安装和 Claude Desktop 的 MCP 接入继续复用原流程。Gemini CLI、Qwen Code、Kiro 仅安装 MCP，不导入聊天历史、不安装采集 Hook、不替用户批准工具信任。

OpenCode 2.x 另装一个 FULI 插件（`<配置目录>/plugins/fuli/index.js`，随 `fuli clients update|rollback` 的客户端包更新），并把 FULI 的 Skills 装进 `<配置目录>/skills/`（OpenCode 会加载这个目录）。OpenCode 用自己的来源名 `opencode`（MCP 入口的 `--source-application` 和插件一致），可在设置里单独关闭记录。在它有自己的名字之前，OpenCode 记作 `other`：已保存的列表不会被改写，读取时只要列表里有 `other` 而没有 `opencode`，就同样算作包含 `opencode`。所以以前关掉了 `other` 的记录，OpenCode 仍然不记；以前允许了 `other` 的 Agent，在 OpenCode 里照样可用。在设置里打开 OpenCode 的记录时，这条旧的 `other` 设置会一并取消。插件在每轮提问时调用 FULI 的任务入口，把入口内容作为本轮的 system 文本交给模型，不改用户原文；在上一轮运行时排队的提问，等 OpenCode 真正送达它时才开始自己的任务。执行成功结束时（或 `opencode run` 退出、插件卸载时）像 Stop hook 一样收尾，每轮只收尾一次；失败或中断不收尾。FULI 慢或不可用时提问照常进行，最多多一行提示。OpenCode 1.x 的插件 API 不兼容，检测到时只接入 MCP 并给出提示；读不到版本（`opencode --version`）时不新装插件。OpenCode 的会话原文只能通过 API 或 `opencode session export` 读取，目前还不自动采集。FULI 在 Windows 上看不到 WSL 里的 OpenCode；WSL 里的 OpenCode 请在 WSL 里运行 `fuli setup`。

OpenCode 的 [配置分层](https://opencode.ai/docs/config/) 可覆盖全局配置；同时存在全局 JSON/JSONC，或设置了配置覆盖环境变量时，界面提供官方手动接入指引，不自动写入。其他项目级配置也可能覆盖全局项。Kiro CLI 的 agent 配置或 `includeMcpJson` 设置可能覆盖/禁用全局 MCP，需按官方说明检查。格式不合法时自动接入会失败并保留原文件。

配置目录遵循客户端官方覆盖变量：Gemini 的 `GEMINI_CLI_HOME` 替代主目录后追加 `.gemini/settings.json`，Qwen 的 `QWEN_HOME` 替代 `.qwen`，Kiro 的 `KIRO_HOME` 替代 `.kiro`。后两者分别追加 `settings.json` 和 `settings/mcp.json`。
