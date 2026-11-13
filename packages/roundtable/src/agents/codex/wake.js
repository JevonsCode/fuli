import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findFile, firstField, lastEntries, listDirectory } from '../session-log.js';

const TURN_START = 'task_started';
const DELEGATION_VARIABLES = Object.freeze(['FULI_ROUNDTABLE_DELEGATION', 'FULI_ROUNDTABLE_PEER_DEPTH']);
// A TOML array of strings; JSON's string escapes are valid TOML basic strings.
const tomlArray = (values) => `[${values.map((value) => JSON.stringify(value)).join(',')}]`;
const TURN_ENDS = new Set(['task_complete', 'turn_aborted']);

// Wakes Codex headlessly in a sandbox (read-only unless a visit request edits its worktree). Resuming records the exchange in
// that conversation; Codex refuses while the conversation is open in the app.
export const codexWake = Object.freeze({
  id: 'codex',

  resolveCommand({ env, which, platform, fileExists = existsSync }) {
    if (env.FULI_CODEX_BIN) return env.FULI_CODEX_BIN;
    const found = which('codex', platform);
    if (found) return found;
    if (platform === 'win32') return newestBundledCodex(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
    const bundled = platform === 'darwin' ? '/Applications/Codex.app/Contents/Resources/codex' : null;
    return bundled && fileExists(bundled) ? bundled : null;
  },

  // mode (roundtable/wake.js WAKE_MODES): answer and read_only run in the
  // read-only sandbox; worktree_edit (an approved visit request, woken in its
  // worktree) in the workspace-write sandbox of that folder, network off as
  // that sandbox has it by default.
  // mcpServer ({ command, args }): FULI's own MCP server; a read_only or
  // worktree_edit wake then replaces the whole mcp_servers table with it, so
  // none of the person's other servers load.
  args({ sessionId, cwd, delegated = false, mode, mcpServer = null }) {
    // Codex MCP children inherit a filtered environment. Pass variable names,
    // never the private capability itself in argv or persisted client config.
    const authority = delegated ? ['-c', `mcp_servers.fuli.env_vars=${tomlArray(DELEGATION_VARIABLES)}`] : [];
    const onlyFuli = mcpServer && mode !== 'answer'
      ? ['-c', `mcp_servers={ fuli = { ${[`command = ${JSON.stringify(mcpServer.command)}`, `args = ${tomlArray(mcpServer.args)}`,
        ...Object.entries(mcpServer.settings ?? {}).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)].join(', ')} } }`] : [];
    const sandbox = mode === 'worktree_edit' ? 'workspace-write' : 'read-only';
    return sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, ...onlyFuli, ...authority, sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, '-C', cwd, ...onlyFuli, ...authority, '-'];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home, env }) {
    const file = sessionFile(sessionId, { home, env });
    return file ? firstField(file, (line) => line.type === 'session_meta' ? line.payload?.cwd : null) : null;
  },

  // `codex exec resume` writes into the conversation in place, so a turn that
  // may still be running there is never joined (rec#109): the ask goes elsewhere.
  // Only evidence counts as idle: the last turn event read is an end, or the
  // whole log was read and no turn ever started. A quiet log (a long tool wait),
  // a start outside the read tail or a line that cannot be read (an event still
  // being written, maybe a new start) proves nothing, so it may still be running.
  turnRunning(sessionId, { home, env }) {
    const file = sessionFile(sessionId, { home, env });
    if (!file) return false;
    const { entries, whole, unreadable } = lastEntries(file);
    if (unreadable) return true;
    const last = entries.filter(entry => entry.type === 'event_msg').map(entry => entry.payload?.type)
      .filter(type => type === TURN_START || TURN_ENDS.has(type)).at(-1);
    return last === undefined ? !whole : !TURN_ENDS.has(last);
  },

  // `codex exec --json` streams items; the last agent message before turn.completed is the answer.
  // No event names the model, so a Codex wake's model stays unknown (rec#129).
  initialState: () => ({ body: '', completed: false, failed: false }),
  nativeSessionId: event => event.type === 'thread.started' ? event.thread_id : null,
  readEvent(event, state) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') state.body = event.item.text ?? '';
    if (event.type === 'turn.completed') state.completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') state.failed = true;
  },
});

function sessionFile(sessionId, { home, env }) {
  return findFile(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), `${sessionId}.jsonl`, 4);
}

// The Codex app keeps each CLI version in its own folder; the newest is current.
export function newestBundledCodex(root) {
  const candidates = [join(root, 'codex.exe'), ...listDirectory(root).map((entry) => join(root, entry, 'codex.exe'))]
    .filter((path) => existsSync(path));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
