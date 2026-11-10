import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findFile, firstField, lastEntries, listDirectory } from '../session-log.js';

// A turn the log shows started but not finished is running, unless the log has
// not moved for this long (a client that crashed mid-turn never finishes it).
const RUNNING_TURN_STALE_MS = 15 * 60_000;
const TURN_ENDS = new Set(['task_complete', 'turn_aborted']);

// Wakes Codex headlessly with a read-only sandbox. Resuming records the exchange in
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

  args({ sessionId, cwd, delegated = false }) {
    // Codex MCP children inherit a filtered environment. Pass variable names,
    // never the private capability itself in argv or persisted client config.
    const authority = delegated ? ['-c', 'mcp_servers.fuli.env_vars=["FULI_ROUNDTABLE_DELEGATION","FULI_ROUNDTABLE_PEER_DEPTH"]'] : [];
    return sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', ...authority, sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, ...authority, '-'];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home, env }) {
    const file = sessionFile(sessionId, { home, env });
    return file ? firstField(file, (line) => line.type === 'session_meta' ? line.payload?.cwd : null) : null;
  },

  // `codex exec resume` writes into the conversation in place, so a turn that
  // is still running there is never joined (rec#109): the ask goes elsewhere.
  turnRunning(sessionId, { home, env, now = Date.now() }) {
    const file = sessionFile(sessionId, { home, env });
    if (!file) return false;
    const { entries, modifiedMs } = lastEntries(file);
    if (now - modifiedMs > RUNNING_TURN_STALE_MS) return false;
    const turns = entries.filter(entry => entry.type === 'event_msg').map(entry => entry.payload?.type);
    const started = turns.lastIndexOf('task_started');
    return started >= 0 && !turns.slice(started + 1).some(type => TURN_ENDS.has(type));
  },

  // `codex exec --json` streams items; the last agent message before turn.completed is the answer.
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
