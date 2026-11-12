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

Restart DSH. Connecting DSH from the FULI console instead does the same for every DSH profile it
can connect at once; in a profile that loads FULI's own bundle the connector stays idle, so nothing
runs twice.

## What it installs

One package in the DSH profile: `src/index.js`, `cordis.patch.yml` (one row that loads the plugin)
and this README. No dependencies of its own and no install scripts. `@deepseek-ai/dsh-mcp-client`
is an optional peer that DSH itself provides. It contains no FULI code.

## What runs, and when

When DSH starts the profile:

1. If DSH started this profile with FULI's own bundle `fuli-dsh` (the profile was connected from
   the FULI console), it does nothing else. This is read from the bundles DSH started this profile
   with (`profileContext.startedBundles`), not from shared files: another profile being connected,
   or FULI's shared copy in `<DSH home>/plugins/fuli`, does not idle it here.
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

## With the FULI console connection

The FULI console links a different package, `fuli-dsh`, into each profile it can connect (from its
shared copy in `<DSH home>/plugins/fuli`); it leaves out a profile that already depends on that name
another way. The two packages never share a name, so neither changes the other's entry.

- A profile that loads both: FULI's `fuli-dsh` runs and the connector stays idle, so each turn has
  one entry, one close and one `fuli` MCP server.
- A profile the console did not connect: the connector works there, whatever other profiles do.
- Disconnecting from the console removes only `fuli-dsh`; the connector takes over again at the
  next DSH start.

## Uninstall

```bash
dsh plugin --profile desktop remove fuli-dsh-connector
```

It keeps no files of its own, so removing the package removes it entirely. What it fed elsewhere
stays where it is: the FULI tasks and records of past DSH turns stay in FULI's data, and the
context messages FULI added stay in DSH's session history.

License: Apache-2.0.
