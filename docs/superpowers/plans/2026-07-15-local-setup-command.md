# Local Setup Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an idempotent `fuli setup` command that initializes the local Personal Runtime, connects supported local agents with one confirmation, starts the local console, and verifies that it is reachable.

**Architecture:** Setup is an orchestration layer outside the application domain. Focused modules resolve platform paths, discover agent CLIs, back up and update MCP configuration through each agent's own CLI, manage the detached local server, and compose a small setup report. The existing SQLite application bootstrap remains the only owner of data initialization.

**Tech Stack:** Plain JavaScript ESM, Node.js 24 standard library, existing SQLite runtime, Node test runner.

---

## File Map

- Create `src/setup/paths.js`: resolve platform-specific data, database, backup, log, state, and runtime entry paths.
- Create `src/setup/agents.js`: discover Codex and Claude Code and describe their MCP installation commands.
- Create `src/setup/config-backup.js`: copy existing agent configuration before a write.
- Create `src/setup/runtime.js`: initialize SQLite, launch or reuse the detached local server, and perform health checks.
- Create `src/setup/options.js`: parse setup-only command flags without leaking them into runtime option parsing.
- Create `src/setup/setup.js`: orchestrate preview, confirmation, agent connection, runtime startup, and result formatting.
- Create `src/cli/setup-command.js`: terminal confirmation and user-facing command output.
- Modify `src/cli.js`: route `setup` before opening the normal command application.
- Modify `src/cli/invocation.js`: recognize `setup` as a command boundary.
- Modify `src/cli/command-registry.js`: include `setup` in command-name discovery without treating it as an application command.
- Modify `README.md`: make source-mode `fuli setup` the primary quick start while keeping bundled installers explicitly planned.
- Test each module in a matching `test/setup-*.test.js` file and extend CLI invocation tests.

### Task 1: Setup paths and options

**Files:**
- Create: `src/setup/paths.js`
- Create: `src/setup/options.js`
- Test: `test/setup-paths.test.js`
- Test: `test/setup-options.test.js`

- [ ] **Step 1: Write failing path tests**

Cover Windows `%LOCALAPPDATA%/Fuli`, macOS `~/Library/Application Support/Fuli`, Linux `$XDG_DATA_HOME/fuli`, explicit `--data-dir`, absolute database/runtime paths, and stable backup/log/state children.

- [ ] **Step 2: Run the path tests and verify RED**

Run: `node --test test/setup-paths.test.js test/setup-options.test.js`

Expected: FAIL because `src/setup/paths.js` and `src/setup/options.js` do not exist.

- [ ] **Step 3: Implement minimal path and option modules**

`parseSetupOptions(args)` returns `{ dataDir, personalSpaceName, port, yes, skipAgents, noStart }`, rejects duplicate or missing values, and rejects unknown flags. `resolveSetupPaths()` returns absolute paths without touching the filesystem.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/setup-paths.test.js test/setup-options.test.js`

Expected: PASS.

### Task 2: Agent discovery and backed-up MCP registration

**Files:**
- Create: `src/setup/agents.js`
- Create: `src/setup/config-backup.js`
- Test: `test/setup-agents.test.js`
- Test: `test/setup-config-backup.test.js`

- [ ] **Step 1: Write failing agent tests**

Define Codex registration as `codex mcp remove fuli` followed by `codex mcp add fuli -- <node> <mcp-server> --db <db> --personal-space <name>`. Define Claude Code registration with `--scope user`. Missing agents are reported as unavailable instead of failing setup. Existing config files are copied into the setup backup directory before the first mutation, and no backup is created when the file is absent.

- [ ] **Step 2: Run the agent tests and verify RED**

Run: `node --test test/setup-agents.test.js test/setup-config-backup.test.js`

Expected: FAIL because the agent modules do not exist.

- [ ] **Step 3: Implement discovery and registration adapters**

Use injected `commandExists` and `runCommand` functions for tests. A failed remove caused by a missing registration is tolerated; a failed add is returned as an agent-specific error. Never include config contents in logs or results.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/setup-agents.test.js test/setup-config-backup.test.js`

Expected: PASS.

### Task 3: Runtime initialization, launch, and health

**Files:**
- Create: `src/setup/runtime.js`
- Test: `test/setup-runtime.test.js`

- [ ] **Step 1: Write failing runtime tests**

Verify that setup opens the existing local application once to run migrations/bootstrap, closes it, reuses a healthy recorded process, starts a detached server when needed, writes only non-secret runtime metadata, waits for `/api/state`, and reports the log path on startup failure.

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `node --test test/setup-runtime.test.js`

Expected: FAIL because `src/setup/runtime.js` does not exist.

- [ ] **Step 3: Implement runtime lifecycle helpers**

Use `openLocalApplication()` for initialization. Launch `process.execPath` with `src/server.js`, `--db`, `--personal-space`, and `--port`; use detached mode, hidden windows on Windows, append-only log files, and an atomic runtime-state write. Poll health with a bounded timeout. `--no-start` initializes data without spawning a process.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/setup-runtime.test.js`

Expected: PASS.

### Task 4: Setup orchestration and CLI surface

**Files:**
- Create: `src/setup/setup.js`
- Create: `src/cli/setup-command.js`
- Modify: `src/cli.js`
- Modify: `src/cli/invocation.js`
- Modify: `src/cli/command-registry.js`
- Test: `test/setup-command.test.js`
- Modify: `test/cli-invocation.test.js`

- [ ] **Step 1: Write failing orchestration and CLI tests**

Verify one preview plus one confirmation, cancellation without filesystem or config writes, `--yes` non-interactive execution, idempotent reruns, setup command recognition before application startup, concise Chinese output, and a non-zero exit on initialization or health failure.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/setup-command.test.js test/cli-invocation.test.js`

Expected: FAIL because `setup` is not routed.

- [ ] **Step 3: Implement setup orchestration and CLI routing**

Make `main()` async. Route `setup` alongside `migrate`, before `openLocalApplication()`. Keep domain commands in the existing registry; expose a separate command-name predicate so invocation parsing recognizes setup without passing it to `dispatchCommand()`.

- [ ] **Step 4: Run focused CLI tests and verify GREEN**

Run: `node --test test/setup-command.test.js test/cli-invocation.test.js test/cli.test.js`

Expected: PASS.

### Task 5: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the quick start**

Document `npm install`, then `node src/cli.js setup` or linked `fuli setup`. State that this source-mode command still requires Node.js 24+, while future packaged installers will bundle the runtime. Document `--yes`, `--data-dir`, `--personal-space`, `--port`, `--skip-agents`, and `--no-start` under an advanced block.

- [ ] **Step 2: Run a no-side-effect setup smoke test**

Run setup against a temporary data directory with `--yes --skip-agents --no-start`, then query the generated SQLite database with the CLI.

Expected: setup succeeds, the database exists, and the personal space is queryable.

- [ ] **Step 3: Run the complete suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 4: Validate files and docs**

Run: `git diff --check`, inspect `git status --short`, and verify README no longer says `fuli setup` is unavailable.

Expected: no whitespace errors, no accidental generated databases/logs/config backups in the worktree, and documentation matches runtime behavior.
