# fuli-dsh-connector

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that connects DSH
to the [FULI](https://github.com/JevonsCode/fuli) installed on the same computer.

With it, each DSH turn starts with FULI's task entry (the person's saved preferences, the project's
remembered facts and the FLA receipt), appended as one context message after the person's words; a
completed turn closes its FULI task; and the model gets FULI's MCP tools (`mcp__fuli__*`).

## Install

Requires FULI 0.27.0 or newer, installed and started once, so that it has written its DSH bundle
into its data directory.

```bash
dsh plugin --profile desktop add "github:JevonsCode/fuli#path:/packages/dsh-connector"
```

Restart DSH. Connecting DSH from the FULI console instead does the same for every DSH profile at
once; the connector then stays idle, so nothing runs twice.

## What it installs

One package in the DSH profile: `src/index.js`, `cordis.patch.yml` (one row that loads the plugin)
and this README. No dependencies of its own and no install scripts. `@deepseek-ai/dsh-mcp-client`
is an optional peer that DSH itself provides. It contains no FULI code.

## What runs, and when

When DSH starts the profile:

1. If `<DSH home>/plugins/fuli` exists (FULI connected this DSH from its console), it does nothing
   else.
2. Otherwise it looks for FULI's data directory: `FULI_DATA_DIR`, or FULI's default
   (`%LOCALAPPDATA%\Fuli` on Windows, `~/Library/Application Support/Fuli` on macOS,
   `$XDG_DATA_HOME/fuli` or `~/.local/share/fuli` elsewhere). A Windows install that chose another
   data folder needs `FULI_DATA_DIR` or the console connection.
3. It imports `<data>/agent-kits/dsh-bundle/index.js`, the lifecycle plugin of that FULI version,
   which runs FULI's own installed code. It starts FULI's MCP server (a local `node` child process
   running FULI's `mcp-server.js` with `--source-application dsh`) as the bundle's
   `cordis.patch.yml` names it, through DSH's MCP client.

During a session, the lifecycle plugin starts FULI's local lifecycle hook (a short `node` process)
at the first step of each turn, to begin FULI's task and read its entry, and once more when a turn
completes, to close that task. It skips subagent sessions. The connector makes no network requests;
what FULI itself does is governed by FULI's settings.

## Without FULI

- FULI not installed, older than 0.27.0, or not started yet: the connector logs one line and does
  nothing. Turns are unchanged.
- FULI installed but its local service not running: turns run normally, each with one context line
  saying FULI was not available. FULI's MCP tools are missing or fail until FULI runs again.
- FULI slow: an entry waits at most about 15 seconds, then the turn continues without it.

## Uninstall

```bash
dsh plugin --profile desktop remove fuli-dsh-connector
```

It keeps no files of its own, so removing the package removes it entirely. What it fed elsewhere
stays where it is: the FULI tasks and records of past DSH turns stay in FULI's data, and the
context messages FULI added stay in DSH's session history.

License: Apache-2.0.
