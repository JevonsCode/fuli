// The public DeepSeek Harness connector (packages/dsh-connector): it finds
// the FULI on this computer and runs the bundle that FULI wrote for DSH.
// Synthetic temporary homes and data directories only; a fake Cordis
// context; no DSH or FULI data directory is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { apply, inject, name } from '../../../packages/dsh-connector/index.js';
import { dshBundleFiles } from '../../../src/agents/dsh/bundle.js';
import { defaultDataDir } from '../../../src/setup/paths.js';

const MCP_CLIENT = Object.freeze({ name: 'mcp-client' });

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-dsh-connector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBundle(dataDir) {
  const bundle = join(dataDir, 'agent-kits', 'dsh-bundle');
  mkdirSync(bundle, { recursive: true });
  const context = { nodePath: process.execPath, runtimeConfigPath: join(dataDir, 'graph-runtime.json'),
    mcpServerPath: fileURLToPath(new URL('../../../src/mcp-server.js', import.meta.url)) };
  for (const [file, text] of Object.entries(dshBundleFiles(context))) writeFileSync(join(bundle, file), text);
  return { bundle, context };
}

function cordis() {
  const listeners = {};
  const plugins = [];
  const logs = [];
  const ctx = {
    on: (event) => { listeners[event] = true; },
    effect: () => {},
    plugin: (module, config) => plugins.push([module, config]),
    logger: { info: (text) => logs.push(['info', text]), warn: (text) => logs.push(['warn', text]) }
  };
  return { ctx, listeners, plugins, logs };
}

const importing = (specifier) => (specifier === '@deepseek-ai/dsh-mcp-client' ? MCP_CLIENT : import(specifier));

test('the connector is a DSH bundle that names its own plugin row', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../packages/dsh-connector/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } });
  assert.equal(manifest.main, 'index.js');
  assert.match(readFileSync(new URL('../../../packages/dsh-connector/cordis.patch.yml', import.meta.url), 'utf8'),
    /id: fuli-connector\n\s+name: fuli-dsh-connector/);
  assert.equal(name, 'fuli-connector');
  assert.deepEqual(inject, ['agents']);
});

test('with FULI\'s bundle it runs FULI\'s lifecycle plugin and FULI\'s MCP server as `dsh`', async (t) => {
  const root = home(t);
  const { context } = writeBundle(join(root, 'fuli-data'));
  const host = cordis();
  await apply(host.ctx, {}, { env: { FULI_DATA_DIR: join(root, 'fuli-data') }, homeDir: root, importModule: importing });
  assert.deepEqual(Object.keys(host.listeners).sort(), ['agent/pre-step', 'session/event']);
  assert.equal(host.plugins.length, 1);
  const [[module, config]] = host.plugins;
  assert.equal(module, MCP_CLIENT);
  assert.deepEqual(config, { transport: 'stdio', serverName: 'fuli', command: process.execPath,
    args: [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath, '--source-application', 'dsh', '--tool-profile', 'chat'] });
  assert.equal(host.logs.at(-1)[0], 'info');
});

test('it stays idle where FULI connected this DSH itself', async (t) => {
  const root = home(t);
  writeBundle(join(root, 'fuli-data'));
  mkdirSync(join(root, 'dsh', 'plugins', 'fuli'), { recursive: true });
  writeFileSync(join(root, 'dsh', 'plugins', 'fuli', 'index.js'), '');
  const host = cordis();
  await apply(host.ctx, {}, { env: { FULI_DATA_DIR: join(root, 'fuli-data'), DSH_HOME: join(root, 'dsh') }, homeDir: root,
    importModule: importing });
  assert.deepEqual([Object.keys(host.listeners), host.plugins], [[], []]);
  assert.match(host.logs[0][1], /stays idle/);
});

test('without FULI, or with a FULI it cannot load, it logs one line and DSH runs on', async (t) => {
  const root = home(t);
  const none = cordis();
  await apply(none.ctx, {}, { env: { FULI_DATA_DIR: join(root, 'missing') }, homeDir: root, importModule: importing });
  assert.deepEqual([Object.keys(none.listeners), none.plugins, none.logs.length], [[], [], 1]);
  assert.match(none.logs[0][1], /no FULI found/);

  writeBundle(join(root, 'fuli-data'));
  const broken = cordis();
  await apply(broken.ctx, {}, { env: { FULI_DATA_DIR: join(root, 'fuli-data') }, homeDir: root,
    importModule: async () => { throw new Error('synthetic import failure'); } });
  assert.equal(broken.plugins.length, 0);
  assert.match(broken.logs[0][1], /could not be loaded \(synthetic import failure\)/);
});

test('without FULI_DATA_DIR it looks where FULI keeps its data by default, on every platform', async (t) => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const root = home(t);
    const env = platform === 'win32' ? { LOCALAPPDATA: join(root, 'Local') } : {};
    writeBundle(defaultDataDir({ platform, env, homeDir: root }));
    const host = cordis();
    await apply(host.ctx, {}, { env, platform, homeDir: root, importModule: importing });
    assert.equal(host.plugins.length, 1, platform);
  }
});
