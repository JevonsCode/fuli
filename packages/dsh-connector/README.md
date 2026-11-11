# fuli-dsh-connector

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects DSH to the
[FULI](https://github.com/JevonsCode/fuli) installed on the same computer.

With it, each DSH turn starts with FULI's task entry (the person's preferences, the project's
remembered facts and the FLA receipt, appended as one context message after the person's words),
a completed turn closes its FULI task, and the model gets FULI's MCP tools (`mcp__fuli__*`).

## Install

FULI must be installed and started once, so that it has written its DSH bundle into its data
directory. Then:

```bash
dsh plugin --profile desktop add "github:JevonsCode/fuli#path:/packages/dsh-connector"
```

Restart DSH. Connecting DSH from the FULI console instead does the same for every DSH profile at
once; the connector then stays idle, so nothing runs twice.

## How it finds FULI

- FULI's data directory: `FULI_DATA_DIR`, otherwise FULI's default
  (`%LOCALAPPDATA%\Fuli` on Windows, `~/Library/Application Support/Fuli` on macOS,
  `$XDG_DATA_HOME/fuli` or `~/.local/share/fuli` elsewhere).
- It loads `<data>/agent-kits/dsh-bundle/index.js`, the lifecycle plugin of that FULI version, and
  starts FULI's MCP server with the `fuli-mcp` settings of the bundle's `cordis.patch.yml` through
  DSH's own `@deepseek-ai/dsh-mcp-client`.
- It ships no FULI code and stores nothing. Without FULI it logs one line and does nothing.
  FULI being slow or stopped never blocks a turn; the turn gets at most one line saying FULI was
  not available.

License: Apache-2.0.
