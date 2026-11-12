// The public DeepSeek Harness connector (packages/dsh-connector): it finds
// the FULI on this computer and runs the bundle that FULI wrote for DSH.
// Synthetic temporary homes and data directories only; a fake Cordis
// context; no DSH or FULI data directory is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { apply, inject, name } from '../../../packages/dsh-connector/src/index.js';
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

// startedBundles: what DSH started this profile with (profileContext); none
// outside a profile DSH launched.
function cordis({ startedBundles } = {}) {
  const listeners = {};
  const plugins = [];
  const logs = [];
  const ctx = {
    get: (service) => (service === 'profileContext' && startedBundles ? { name: 'desktop', startedBundles } : undefined),
    on: (event) => { listeners[event] = (listeners[event] ?? 0) + 1; },
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
  assert.equal(manifest.main, 'src/index.js');
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

// FULI's console connection leaves a shared copy at <DSH home>/plugins/fuli
// and links `fuli-dsh` into the profiles it could connect.
function consoleConnected(root, profiles) {
  const plugin = join(root, 'dsh', 'plugins', 'fuli');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'index.js'), '');
  for (const [profile, bundles] of Object.entries(profiles)) {
    mkdirSync(join(root, 'dsh', 'profiles', profile), { recursive: true });
    writeFileSync(join(root, 'dsh', 'profiles', profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }));
  }
  return { DSH_HOME: join(root, 'dsh') };
}

test('a shared FULI copy in the DSH home does not idle the connector of a profile that does not load it', async (t) => {
  const root = home(t);
  writeBundle(join(root, 'fuli-data'));
  const env = { FULI_DATA_DIR: join(root, 'fuli-data'), ...consoleConnected(root, {}) };
  const host = cordis({ startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-desktop', 'fuli-dsh-connector'] });
  await apply(host.ctx, {}, { env, homeDir: root, importModule: importing });
  assert.deepEqual(host.listeners, { 'agent/pre-step': 1, 'session/event': 1 });
  assert.equal(host.plugins.length, 1);
});

test('another profile connected from the console does not idle this one', async (t) => {
  const root = home(t);
  writeBundle(join(root, 'fuli-data'));
  // Profile web was connected; this profile (desktop) was left out, e.g. it
  // already depended on another `fuli-dsh`, and installed the connector.
  const env = { FULI_DATA_DIR: join(root, 'fuli-data'), ...consoleConnected(root, {
    web: ['@deepseek-ai/dsh-base', 'fuli-dsh'], desktop: ['@deepseek-ai/dsh-base', 'fuli-dsh-connector'] }) };
  const host = cordis({ startedBundles: ['@deepseek-ai/dsh-base', 'fuli-dsh-connector'] });
  await apply(host.ctx, {}, { env, homeDir: root, importModule: importing });
  assert.deepEqual(host.listeners, { 'agent/pre-step': 1, 'session/event': 1 });
  assert.equal(host.plugins.length, 1);
});

test('in a profile that loads both, FULI\'s own bundle runs alone: one entry and one close per turn', async (t) => {
  const root = home(t);
  const { bundle } = writeBundle(join(root, 'fuli-data'));
  const env = { FULI_DATA_DIR: join(root, 'fuli-data'), ...consoleConnected(root, {
    desktop: ['@deepseek-ai/dsh-base', 'fuli-dsh', 'fuli-dsh-connector'] }) };
  const host = cordis({ startedBundles: ['@deepseek-ai/dsh-base', 'fuli-dsh', 'fuli-dsh-connector'] });
  // DSH loads FULI's linked bundle (its plugin row; its MCP row is loaded by DSH, not by code)...
  (await import(pathToFileURL(join(bundle, 'index.js')).href)).apply(host.ctx);
  // ...and the connector, which leaves it alone.
  await apply(host.ctx, {}, { env, homeDir: root, importModule: importing });
  assert.deepEqual(host.listeners, { 'agent/pre-step': 1, 'session/event': 1 });
  assert.deepEqual(host.plugins, [], 'no second fuli MCP server');
  assert.match(host.logs[0][1], /stays idle/);
});

test('outside a profile DSH launched (no profileContext) the connector runs', async (t) => {
  const root = home(t);
  writeBundle(join(root, 'fuli-data'));
  const host = cordis();
  await apply(host.ctx, {}, { env: { FULI_DATA_DIR: join(root, 'fuli-data') }, homeDir: root, importModule: importing });
  assert.deepEqual(host.listeners, { 'agent/pre-step': 1, 'session/event': 1 });
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
