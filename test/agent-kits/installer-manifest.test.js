import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareInstallerManifest } from '../../src/agent-kits/installer-manifest.js';

// What FULI's product manifest asks agent-installer to write into each
// client. The snapshot was recorded when FULI's own config writers were
// removed (rec#11 #11), after a parity test had shown, client by client,
// that the manifest asks for exactly what those writers wrote: MCP command,
// arguments and extra fields, hooks, Claude Code permissions, the Codex
// instruction block, Skills and the OpenCode plugin. A change here is a
// change to every connected client; review it as one.
const SNAPSHOT = new URL('../fixtures/installer-manifest-snapshot.json', import.meta.url);

function composed(t, openCodePlugin) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-manifest-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'agent-kits', 'fuli-installer.json');
  const context = { dataDir: join(root, 'data'), nodePath: join(root, 'node'), mcpServerPath: join(root, 'src', 'mcp-server.js'),
    runtimeConfigPath: join(root, 'data', 'graph-runtime.json'), skillsDir: join(root, 'skills') };
  const variables = prepareInstallerManifest({ manifestPath, context, openCodePlugin });
  return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), variables, root };
}

test('the manifest asks every client for what FULI installed there before agent-installer wrote it', (t) => {
  const { manifest } = composed(t, true);
  const { schemaVersion, product, name, mcp, clients } = manifest;
  assert.deepEqual({ schemaVersion, product, name, mcp, clients }, JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
});

test('the OpenCode plugin is named only where OpenCode takes it, beside its source', (t) => {
  const without = composed(t, false);
  assert.equal(without.manifest.clients.opencode.plugin, undefined);
  assert.equal(without.variables.openCodePlugin, undefined);
  const withPlugin = composed(t, true);
  assert.equal(withPlugin.variables.openCodePlugin, join(withPlugin.root, 'agent-kits', 'opencode-plugin'));
  assert.match(readFileSync(join(withPlugin.variables.openCodePlugin, 'index.js'), 'utf8'), /fuliOpenCodePlugin/);
  assert.deepEqual(Object.keys(withPlugin.variables).sort(), ['claudeHook', 'codexHook', 'cursorHook', 'mcpServerPath',
    'nodePath', 'openCodePlugin', 'runtimeConfigPath', 'skillsDir']);
});
