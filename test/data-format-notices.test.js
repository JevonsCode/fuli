import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { dataFormatNoticeLine, dataFormatNotices } from '../src/data-format/format-notices.js';
import { createServer } from '../src/server.js';

test('a store waiting for a person is named with its step, read only and cached briefly (rec#17)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-format-notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(join(root, 'judgment.sqlite'));
  database.exec('CREATE TABLE judgment_settings(space TEXT); PRAGMA user_version = 4;');
  database.close();
  let clock = 0;
  let inspections = 0;
  const notices = dataFormatNotices(root, { now: () => clock, inspect: () => {
    inspections += 1;
    return [{ store: 'agent-apps', label: 'agent-apps/registry.sqlite', state: 'pending_confirmation',
      steps: [{ id: 'agent-apps/7-identity-keys' }] }, { store: 'judgment', label: 'judgment.sqlite',
      state: 'current', steps: [] }];
  } });

  assert.deepEqual(notices(), [{ store: 'agent-apps', label: 'agent-apps/registry.sqlite',
    state: 'pending_confirmation', steps: ['agent-apps/7-identity-keys'] }]);
  notices();
  clock = 10_001;
  notices();
  assert.equal(inspections, 2);
  assert.equal(dataFormatNoticeLine(notices()[0]), 'Data format: store agent-apps (agent-apps/registry.sqlite) '
    + 'is pending_confirmation; steps agent-apps/7-identity-keys. Run `fuli migrate status` for details.');
  assert.deepEqual(dataFormatNotices(root)(), [{ store: 'judgment', label: 'judgment.sqlite',
    state: 'newer_format', steps: [] }]);
});

test('console health lists the stores this FULI cannot use as they are', async () => {
  const notice = { store: 'judgment', label: 'judgment.sqlite', state: 'newer_format', steps: [] };
  const runtime = await createServer({ port: 0, dataFormatNotices: () => [notice],
    app: { graphiti: true, async state() { throw new Error('not queried'); }, close() {} } });
  try {
    const health = await (await fetch(`${runtime.url}/api/health`)).json();
    assert.deepEqual(health.dataFormats, [notice]);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
  }
});
