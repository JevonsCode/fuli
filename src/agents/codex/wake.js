import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findFile, firstField, listDirectory } from '../session-log.js';

// Wakes Codex headlessly with a read-only sandbox. Resuming records the exchange in
// that conversation; Codex refuses while the conversation is open in the app.
export const codexWake = Object.freeze({
  id: 'codex',

  judgmentArgs({ cwd, quality }) {
    return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd,
      '-c', 'project_doc_max_bytes=0', '-c', 'features.shell_tool=false',
      '-c', `model_reasoning_effort="${quality === 'economy' ? 'low' : quality === 'balanced' ? 'medium' : 'high'}"`, '-'];
  },

  resolveCommand({ env, which, platform, fileExists = existsSync }) {
    if (env.FULI_CODEX_BIN) return env.FULI_CODEX_BIN;
    const found = which('codex', platform);
    if (found) return found;
    if (platform === 'win32') return newestBundledCodex(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
    const bundled = platform === 'darwin' ? '/Applications/Codex.app/Contents/Resources/codex' : null;
    return bundled && fileExists(bundled) ? bundled : null;
  },

  args({ sessionId, cwd }) {
    return sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', sessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd, '-'];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home, env }) {
    const file = findFile(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), `${sessionId}.jsonl`, 4);
    return file ? firstField(file, (line) => line.type === 'session_meta' ? line.payload?.cwd : null) : null;
  },

  // `codex exec --json` streams items; the last agent message before turn.completed is the answer.
  initialState: () => ({ body: '', completed: false, failed: false }),
  readEvent(event, state) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') state.body = event.item.text ?? '';
    if (event.type === 'turn.completed') state.completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') state.failed = true;
  },
});

// The Codex app keeps each CLI version in its own folder; the newest is current.
function newestBundledCodex(root) {
  const candidates = [join(root, 'codex.exe'), ...listDirectory(root).map((entry) => join(root, entry, 'codex.exe'))]
    .filter((path) => existsSync(path));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
