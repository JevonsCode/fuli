import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClientInstallerPort, noteChanged } from '../../src/agent-kits/client-installer.js';

// The port without a usable agent-installer: nothing is written and every
// call says so. Synthetic paths only.
function port(t, executable, retireLegacy = () => assert.fail('no client file is touched without agent-installer')) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-installer-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { dataDir: join(root, 'data'), nodePath: '/runtime/node', mcpServerPath: join(root, 'src', 'mcp-server.js'),
    runtimeConfigPath: '/data/runtime.json', skillsDir: join(root, 'skills') };
  return createClientInstallerPort({ manifestPath: join(root, 'agent-kits', 'fuli-installer.json'), context,
    backupsDir: join(root, 'backups'), extensionsDir: join(root, 'extensions'), openCode: () => ({ plugin: false, nextStep: null }),
    retireLegacy, executables: { ensure: async () => executable } });
}

test('a write without agent-installer answers unavailable instead of falling back to a writer of FULI\'s own', async (t) => {
  const offline = port(t, { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  for (const action of ['plan', 'apply', 'remove']) {
    assert.deepEqual(await offline[action](['codex']), { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  }
  assert.deepEqual(await offline.status(), { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  // An executable that cannot start is no different. (The legacy hook step
  // runs first; FULI only names an executable it found on disk.)
  const retired = [];
  const broken = port(t, { status: 'available', path: join(tmpdir(), 'fuli-missing-agent-installer', 'agent-installer.exe') },
    (ids) => retired.push(ids));
  assert.equal((await broken.apply(['gemini'])).status, 'unavailable');
  assert.deepEqual(retired, [['gemini']]);
});

test('only a change an open session would not reread leaves a note, and only for a client FULI can tell apart', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-note-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'runtime.json');
  noteChanged([
    { id: 'codex', changes: [{ path: '~/.codex/config.toml', components: ['mcp'] }] },
    { id: 'claude-code', changes: [{ path: '~/.claude/skills/fuli', components: ['skills'] }] },
    { id: 'cursor', changes: [] },
    { id: 'gemini', changes: [{ path: '~/.gemini/settings.json', components: ['hooks'] }] }
  ], config);
  assert.deepEqual(readdirSync(join(root, 'mcp-processes')), ['client-changed-claude_code.json']);
});
