import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sessionClientRecords } from '../../../src/agent-kits/session-clients.js';
import { recordClaudeSessionClient } from '../../../src/agents/claude-code/session-client.js';
import { reachableModules } from '../../../test-support/module-graph.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function dataDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-session-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a Claude Code hook records the raw entry point once per session, synchronously and without the launcher', (t) => {
  const root = dataDirectory(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  const record = (sessionId, entrypoint) => {
    const returned = recordClaudeSessionClient({ runtimeConfigPath, sessionId,
      // Even a usable launcher override is never started from a hook.
      env: { FULI_AGENT_SESSION_LAUNCHER: process.execPath, ...(entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint }) } });
    assert.equal(returned, undefined, 'nothing to wait for');
    return sessionClientRecords(root).read('claude_code', sessionId);
  };
  assert.deepEqual(record('desktop', 'claude-desktop'), { client: null, source: 'Claude Code', entrypoint: 'claude-desktop' });
  assert.deepEqual(record('terminal', 'cli'), { client: null, source: 'Claude Code CLI', entrypoint: 'cli' });
  assert.deepEqual(record('ide', ' claude-vscode '), { client: null, source: 'Claude Code', entrypoint: 'claude-vscode' });
  assert.deepEqual(record('older-claude'), { client: null, source: 'Claude Code', entrypoint: null });
  assert.deepEqual(record('desktop', 'cli'), { client: null, source: 'Claude Code', entrypoint: 'claude-desktop' },
    'a later hook of the same session keeps the first record');
  assert.deepEqual(readdirSync(root), ['session-clients'], 'nothing else is written or downloaded');
  assert.equal(sessionClientRecords(root).read('codex', 'desktop'), null, 'records are per source application');
});

test('the Claude Code hook cannot reach the session launcher or its executables', () => {
  const reached = [...reachableModules(join(ROOT, 'src', 'agents', 'claude-code', 'lifecycle-hook.js'))]
    .map((path) => relative(ROOT, path).split(sep).join('/'));
  assert.ok(reached.includes('src/agents/claude-code/session-client.js'));
  assert.ok(reached.includes('src/agent-kits/session-clients.js'));
  // Only the record store, the pinned versions (data the Windows bundle reader checks) and
  // client-detection's pure mapping (it imports nothing; the installer is passed in) are reachable.
  assert.deepEqual(reached.filter((path) => path.startsWith('src/agent-kits/')).sort(),
    ['src/agent-kits/client-detection.js', 'src/agent-kits/pins.js', 'src/agent-kits/session-clients.js']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'agent-kits', 'client-detection.js'), 'utf8'), /^\s*import\b/m);
});
