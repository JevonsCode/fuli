import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = resolve('src/cli.js');
const MCP = resolve('src/mcp-server.js');
const WEB = resolve('src/server.js');
const STORE = resolve('src/store.js');
const FACADE_PROBE = `
  import { createServer } from ${JSON.stringify(pathToFileURL(WEB).href)};
  import { FileStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
  const mode = process.argv[1];
  const options = { port: 0 };
  if (mode === 'explicit') options.dbPath = '.fuli/context.db';
  if (mode === 'app') options.app = {};
  if (mode === 'store') options.store = new FileStore(':memory:');
  try {
    const { server } = await createServer(options);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.stdout.write('started');
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
`;

test('CLI refuses an implicit default upgrade over legacy JSON', () => {
  const fixture = legacyFixture('fuli-upgrade-cli-');
  const result = spawnSync(process.execPath, [CLI, 'search', '我', 'query'], {
    cwd: fixture.cwd,
    encoding: 'utf8'
  });

  assertGuarded(result, fixture);
});

test('Web startup refuses an implicit default upgrade over legacy JSON', () => {
  const fixture = legacyFixture('fuli-upgrade-web-');
  const result = spawnSync(process.execPath, [WEB, '--port', '0'], {
    cwd: fixture.cwd,
    encoding: 'utf8',
    timeout: 3000
  });

  assertGuarded(result, fixture);
});

test('MCP startup reports the safe implicit-upgrade migration command', () => {
  const fixture = legacyFixture('fuli-upgrade-mcp-');
  const result = spawnSync(process.execPath, [
    MCP, '--call', 'get_user_lens', '--input', '{"task":"test","budget":1000}'
  ], {
    cwd: fixture.cwd,
    encoding: 'utf8'
  });

  assertGuarded(result, fixture);
});

test('createServer facade guards an omitted default database', () => {
  const fixture = legacyFixture('fuli-upgrade-facade-');
  const result = runFacade(fixture, 'implicit');

  assertGuarded(result, fixture);
});

test('createServer facade respects an explicitly supplied default database', () => {
  const fixture = legacyFixture('fuli-upgrade-explicit-');
  const result = runFacade(fixture, 'explicit');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'started');
  assert.equal(existsSync(fixture.dbPath), true);
  assert.equal(readFileSync(fixture.legacyPath, 'utf8'), fixture.original);
});

test('createServer facade inherits an environment database without guarding it', () => {
  const fixture = legacyFixture('fuli-upgrade-env-');
  const envDbPath = join(fixture.cwd, 'runtime', 'env.db');
  const result = runFacade(fixture, 'environment', { FULI_DB_PATH: envDbPath });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'started');
  assert.equal(existsSync(envDbPath), true);
  assert.equal(existsSync(fixture.dbPath), false);
  assert.equal(readFileSync(fixture.legacyPath, 'utf8'), fixture.original);
});

test('createServer facade skips unrelated runtime resolution for injected app and store', () => {
  for (const mode of ['app', 'store']) {
    const fixture = legacyFixture(`fuli-upgrade-injected-${mode}-`);
    const result = runFacade(fixture, mode, {
      FULI_DB_PATH: '',
      FULI_PERSONAL_SPACE: ''
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'started');
    assert.equal(existsSync(fixture.dbPath), false);
    assert.equal(readFileSync(fixture.legacyPath, 'utf8'), fixture.original);
  }
});

function legacyFixture(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(cwd, '.fuli');
  const legacyPath = join(directory, 'context.json');
  const dbPath = join(directory, 'context.db');
  const original = '{"legacy":"unchanged"}\n';
  mkdirSync(directory);
  writeFileSync(legacyPath, original, 'utf8');
  return { cwd, legacyPath, dbPath, original };
}

function assertGuarded(result, fixture) {
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /node src\/cli\.js migrate --from .*context\.json/);
  assert.match(result.stderr, /--to .*context\.db/);
  assert.equal(existsSync(fixture.dbPath), false);
  assert.equal(readFileSync(fixture.legacyPath, 'utf8'), fixture.original);
}

function runFacade(fixture, mode, overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!Object.hasOwn(overrides, 'FULI_DB_PATH')) delete env.FULI_DB_PATH;
  if (!Object.hasOwn(overrides, 'FULI_PERSONAL_SPACE')) delete env.FULI_PERSONAL_SPACE;
  return spawnSync(process.execPath, [
    '--input-type=module', '--eval', FACADE_PROBE, mode
  ], {
    cwd: fixture.cwd,
    encoding: 'utf8',
    env,
    timeout: 3000
  });
}
