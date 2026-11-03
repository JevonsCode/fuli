import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createClientInstallerPort } from '../../src/agent-kits/client-installer.js';

// The port without a usable agent-installer: nothing is written and every
// call says so. Synthetic paths only.
function port(t, executable) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-client-installer-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { dataDir: join(root, 'data'), nodePath: '/runtime/node', mcpServerPath: join(root, 'src', 'mcp-server.js'),
    runtimeConfigPath: '/data/runtime.json', skillsDir: join(root, 'skills') };
  return createClientInstallerPort({ manifestPath: join(root, 'agent-kits', 'fuli-installer.json'), context,
    backupsDir: join(root, 'backups'), extensionsDir: join(root, 'extensions'), openCode: () => ({ plugin: false, nextStep: null }),
    executables: { ensure: async () => executable } });
}

test('a write without agent-installer answers unavailable instead of falling back to a writer of FULI\'s own', async (t) => {
  const offline = port(t, { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  for (const action of ['plan', 'apply', 'remove']) {
    assert.deepEqual(await offline[action](['codex']), { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  }
  assert.deepEqual(await offline.status(), { status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' });
  // An executable that cannot start is no different.
  const broken = port(t, { status: 'available', path: join(tmpdir(), 'fuli-missing-agent-installer', 'agent-installer.exe') });
  assert.equal((await broken.apply(['gemini'])).status, 'unavailable');
});
