import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { closeServer, getJson, postJson } from '../test-support/server.js';

const CLI = resolve('src/cli.js');

test('server uses the default SQLite database and bootstraps before serving', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-server-default-'));
  const dataRoot = join(cwd, 'system-data');
  const env = process.platform === 'win32'
    ? { ...process.env, LOCALAPPDATA: dataRoot, USERPROFILE: cwd }
    : { ...process.env, XDG_DATA_HOME: dataRoot, HOME: cwd };
  let server;
  try {
    const created = await createServer({ port: 0, cwd, env, homeDir: cwd });
    server = created.server;
    const state = await getJson(`${created.url}/api/state`);
    assert.deepEqual(state.spaces.map(({ name }) => name), ['我', '工作']);
    assert.equal(existsSync(resolveSetupPaths({ env, homeDir: cwd }).dbPath), true);
    assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
  } finally {
    if (server) await closeServer(server);
  }
});

test('fresh server bootstrap honors the active personal space name', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-personal-')), 'context.db');
  const { server, app } = await createServer({
    dbPath,
    personalSpaceName: 'Jevons',
    port: 0
  });

  try {
    assert.equal(app.activePersonalSpace().name, 'Jevons');
  } finally {
    await closeServer(server);
  }
});

test('server rejects JSON live paths without modifying the legacy file', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-json-')), 'context.JSON');
  const original = '{"legacy":true}\n';
  writeFileSync(dbPath, original, 'utf8');

  await assert.rejects(() => createServer({ dbPath, port: 0 }), /node src\/cli\.js migrate/);
  assert.equal(readFileSync(dbPath, 'utf8'), original);
});

test('CLI and Web persist changes through the same SQLite runtime', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-shared-')), 'context.db');
  execFileSync(process.execPath, [
    CLI, '--db', dbPath, 'remember', '我', '--target', '工作', '--source-kind', 'prd',
    '--text', 'cli_url: https://cli.example.com'
  ]);

  const { server, url } = await createServer({ dbPath, port: 0 });
  const state = await getJson(`${url}/api/state`);
  const personal = state.spaces.find(({ name }) => name === '我');
  const project = state.spaces.find(({ name }) => name === '工作');
  const fromCli = await getJson(
    `${url}/api/search?personalSpaceId=${personal.id}&q=cli_url`
  );
  assert.equal(fromCli.facts[0].object, 'https://cli.example.com');

  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'web_url: https://web.example.com'
  });
  await closeServer(server);

  const fromWeb = execFileSync(process.execPath, [
    CLI, '--db', dbPath, 'search', '我', 'web_url'
  ], { encoding: 'utf8' });
  assert.match(fromWeb, /https:\/\/web\.example\.com/);
});
