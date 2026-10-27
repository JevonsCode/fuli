import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { dataFormatNoticeLine, dataFormatNotices, latestNotices } from '../src/data-format/format-notices.js';
import { handleApiRequest } from '../src/http/api-router.js';
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

// Root cause of Update-Fuli's "The running Fuli could not be stopped": `fuli
// stop` stops the console only after /api/health answers with its PID within
// 2.5 s (twice, 3 s apart). That route inspected every store on the request,
// synchronously, and an open client session's write lock on one store keeps
// the inspection waiting for the store's busy timeout, so the console answered
// nothing in time and `stop` left it running as "unverified".
test('a store another process is writing keeps the inspection waiting past the stop\'s identity check', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-format-lock-'));
  const database = new DatabaseSync(join(root, 'judgment.sqlite'));
  database.exec('CREATE TABLE judgment_settings(space TEXT); PRAGMA user_version = 4;');
  database.close();
  // A synthetic writer (as an open session's MCP process would be) holding the store's write lock.
  const writer = spawn(process.execPath, ['-e', "const { DatabaseSync } = require('node:sqlite');"
    + "const d = new DatabaseSync(process.argv[1]); d.exec('BEGIN EXCLUSIVE');"
    + "d.exec(\"INSERT INTO judgment_settings VALUES ('s')\"); process.stdout.write('locked'); setInterval(() => {}, 1000);",
  join(root, 'judgment.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    const exited = once(writer, 'exit');
    writer.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  await once(writer.stdout, 'data');
  const started = performance.now();
  const notices = dataFormatNotices(root)();
  assert.ok(performance.now() - started > 2500, 'the inspection waited on the lock longer than the stop waits for an answer');
  assert.deepEqual(notices.map(({ store, state }) => [store, state]), [['judgment', 'unavailable']]);
});

test('console health answers with the latest notices and inspects only after the answer', async () => {
  const notice = { store: 'judgment', label: 'judgment.sqlite', state: 'unavailable', steps: [] };
  let inspections = 0;
  const later = [];
  const notices = latestNotices(() => { inspections += 1; return [notice]; }, { schedule: (work) => later.push(work) });
  assert.equal(inspections, 1, 'read once when the console starts');
  const sent = [];
  const response = { setHeader() {}, writeHead(status) { sent.push(status); return this; }, end(body) { sent.push(JSON.parse(body)); } };
  await handleApiRequest({ request: { method: 'GET', url: '/api/health', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    response, app: {}, dataFormats: notices });
  assert.equal(sent[0], 200);
  assert.deepEqual(sent[1].dataFormats, [notice]);
  assert.equal(inspections, 1, 'nothing was inspected on the request');
  later.splice(0).forEach((work) => work());
  assert.equal(inspections, 2);
});
