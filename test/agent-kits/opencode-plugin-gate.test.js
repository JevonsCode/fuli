import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { openCodePluginGate } from '../../src/agent-kits/opencode-plugin-gate.js';
import { openCodePluginSource } from '../../src/agents/opencode/plugin-file.js';
import { builtInClientPack } from '../../test-support/client-packs.js';

// Synthetic homes only; no real OpenCode is started or read.
function home(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-opencode-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const gate = (homeDir, version, env = {}) => openCodePluginGate({ env, homeDir, commandVersion: () => version });

test('OpenCode 2.x gets FULI\'s plugin; 1.x only the MCP entry, and the person is told why', (t) => {
  const homeDir = home(t);
  assert.deepEqual(gate(homeDir, '2.1.4'), { plugin: true, nextStep: null });
  const v1 = gate(homeDir, '1.4.0');
  assert.equal(v1.plugin, false);
  assert.match(v1.nextStep, /OpenCode 1\.4\.0 found: FULI's per-prompt plugin needs OpenCode 2\.x/);
});

test('an unreadable version keeps a FULI plugin already there and installs none new', (t) => {
  const homeDir = home(t);
  const unknown = gate(homeDir, null);
  assert.equal(unknown.plugin, false);
  assert.match(unknown.nextStep, /version could not be read/);
  const config = join(homeDir, 'xdg');
  mkdirSync(join(config, 'opencode', 'plugins', 'fuli'), { recursive: true });
  const context = { nodePath: '/runtime/node', mcpServerPath: '/pkg/src/mcp-server.js', runtimeConfigPath: '/data/runtime.json' };
  writeFileSync(join(config, 'opencode', 'plugins', 'fuli', 'index.js'),
    openCodePluginSource(context, builtInClientPack('opencode').lifecycleHooks));
  assert.deepEqual(gate(homeDir, null, { XDG_CONFIG_HOME: config }), { plugin: true, nextStep: null });
  // Someone else's plugin of that name is not FULI's to keep.
  writeFileSync(join(config, 'opencode', 'plugins', 'fuli', 'index.js'), 'export default {};\n');
  assert.equal(gate(homeDir, null, { XDG_CONFIG_HOME: config }).plugin, false);
});

// The real probe against a synthetic `opencode` on PATH that prints what
// OpenCode 2.1.4 prints. No real OpenCode or home directory is touched.
test('the gate reads OpenCode\'s real `opencode v2.1.4` version line', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'fuli-opencode-bin-'));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });
  if (process.platform === 'win32') writeFileSync(join(bin, 'opencode.cmd'), '@echo opencode v2.1.4\r\n');
  else writeFileSync(join(bin, 'opencode'), '#!/bin/sh\nprintf "opencode v2.1.4\n"\n', { mode: 0o755 });
  process.env.PATH = `${bin}${delimiter}${path}`;
  assert.deepEqual(openCodePluginGate({ env: {}, homeDir: home(t) }), { plugin: true, nextStep: null });
});
