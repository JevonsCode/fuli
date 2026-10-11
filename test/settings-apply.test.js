import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSettingsApplier, runSettingsApply } from '../src/system/settings-apply.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings, writeRuntimeSettings } from '../src/system/runtime-settings.js';
import { readJsonFile, writeJsonFileAtomic } from '../src/storage/json-file.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-settings-apply-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = { dataDir, runtimeSettingsPath: join(dataDir, 'settings.json'), graphRuntimeConfigPath: join(dataDir, 'graph.json') };
  writeRuntimeSettings(paths.runtimeSettingsPath, DEFAULT_RUNTIME_SETTINGS);
  return paths;
}

test('settings apply is queued once, starts after the response, and reports success after restart', async (t) => {
  const paths = fixture(t);
  const calls = [];
  const applier = createSettingsApplier({ paths, checkPorts: async () => {}, spawnWorker: () => {
    calls.push('spawn'); return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  } });
  const next = { ...DEFAULT_RUNTIME_SETTINGS, lanAccess: true };
  const pending = await applier.prepare(next, DEFAULT_RUNTIME_SETTINGS);
  assert.equal(pending.status, 'applying');
  assert.deepEqual(calls, []);
  await assert.rejects(applier.prepare(next, DEFAULT_RUNTIME_SETTINGS), /already being applied/);
  applier.start(pending.id); applier.start(pending.id);
  assert.deepEqual(calls, ['spawn']);
  await runSettingsApply(paths, pending.id, { restart: async (input) => {
    assert.equal(input.runtimeSettings.lanAccess, true);
    assert.equal(applier.status().status, 'applying');
    calls.push('restart');
  } });
  assert.equal(applier.status().status, 'applied');
});

test('failed application restores the previous settings and graph connection before recovery', async (t) => {
  const paths = fixture(t);
  const original = { personal: { providerUrl: 'http://127.0.0.1:8787' } };
  writeJsonFileAtomic(paths.graphRuntimeConfigPath, original);
  const applier = createSettingsApplier({ paths, checkPorts: async () => {} });
  const pending = await applier.prepare({ ...DEFAULT_RUNTIME_SETTINGS, lanAccess: true }, DEFAULT_RUNTIME_SETTINGS);
  let recovered = false;
  await runSettingsApply(paths, pending.id, {
    restart: async () => {
      writeJsonFileAtomic(paths.graphRuntimeConfigPath, { changed: true });
      throw new Error('Synthetic startup failure');
    },
    stop: async () => {},
    start: async () => {
      recovered = true;
      assert.equal(readRuntimeSettings(paths.runtimeSettingsPath).lanAccess, false);
      assert.deepEqual(readJsonFile(paths.graphRuntimeConfigPath), original);
    },
  });
  assert.equal(recovered, true);
  assert.equal(applier.status().status, 'failed');
  assert.equal(applier.status().rolledBack, true);
});

test('occupied target port is rejected before persisting or restarting', async (t) => {
  const paths = fixture(t);
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const applier = createSettingsApplier({ paths });
  await assert.rejects(applier.prepare({ ...DEFAULT_RUNTIME_SETTINGS,
    ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, console: occupied.address().port },
  }, DEFAULT_RUNTIME_SETTINGS), /already in use/);
  assert.deepEqual(readRuntimeSettings(paths.runtimeSettingsPath), DEFAULT_RUNTIME_SETTINGS);
});
