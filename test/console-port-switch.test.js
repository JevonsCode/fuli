import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSetupPaths } from '../src/setup/paths.js';
import { switchConsolePort } from '../src/system/console-port-switch.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const RESERVED = Object.freeze([{ start: 2634, end: 2733 }, { start: 7600, end: 7699 }]);
const AT = new Date('2026-10-27T08:00:00.000Z');

async function dataDir(t, settings) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-port-switch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveSetupPaths({ dataDir: root });
  if (settings) await writeFile(paths.runtimeSettingsPath, JSON.stringify(settings, null, 2));
  return paths;
}

test('the console moves near the default, outside reserved ranges and busy ports, keeping a backup', async (t) => {
  const previous = { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native',
    ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, console: 2727 } };
  const paths = await dataDir(t, previous);
  const before = await readFile(paths.runtimeSettingsPath, 'utf8');
  const probed = [];
  const result = await switchConsolePort(paths, {
    platform: 'win32',
    readRanges: ({ platform }) => { assert.equal(platform, 'win32'); return RESERVED; },
    probe: async (port, host) => { probed.push([port, host]); return port === 2734 ? 'EADDRINUSE' : null; },
    now: () => AT
  });

  assert.deepEqual(probed, [[2734, '127.0.0.1'], [2735, '127.0.0.1']]);
  assert.equal(result.previousPort, 2727);
  assert.equal(result.port, 2735);
  const saved = JSON.parse(await readFile(paths.runtimeSettingsPath, 'utf8'));
  assert.equal(saved.ports.console, 2735);
  assert.equal(saved.ports.personalNeo4jBolt, 7700, 'a reserved Neo4j port moves too');
  assert.equal(saved.ports.personalProvider, previous.ports.personalProvider);
  assert.equal(saved.graphRuntimeMode, 'native');
  assert.equal(result.backupPath, join(paths.dataDir, 'backups', 'settings', 'runtime-settings-2026-10-27T08-00-00-000Z.json'));
  assert.equal(await readFile(result.backupPath, 'utf8'), before);
  assert.deepEqual((await readdir(paths.dataDir)).filter((name) => name.includes('.tmp')), [], 'no temporary file is left');
});

test('a console already off the default never keeps its current port and never takes another FULI port', async (t) => {
  const paths = await dataDir(t, { ...DEFAULT_RUNTIME_SETTINGS,
    ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, console: 2828, personalProvider: 2727 } });
  const result = await switchConsolePort(paths, { platform: 'win32', readRanges: () => [], probe: async () => null, now: () => AT });
  assert.equal(result.previousPort, 2828);
  assert.equal(result.port, 2728, 'the default is taken by the Provider, so the next port up');
});

test('LAN access probes the port on every interface the console will listen on', async (t) => {
  const paths = await dataDir(t, { ...DEFAULT_RUNTIME_SETTINGS, lanAccess: true });
  const hosts = new Set();
  await switchConsolePort(paths, { platform: 'win32', readRanges: () => RESERVED,
    probe: async (_port, host) => { hosts.add(host); return null; }, now: () => AT });
  assert.deepEqual([...hosts], ['0.0.0.0']);
});
