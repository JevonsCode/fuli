import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../src/storage/sqlite-store.js';
import { tmpdir } from 'node:os';

const NODE = process.execPath;
const CLI = resolve('src/cli.js');

function runCli(dbPath, ...args) {
  return runCliIn(process.cwd(), dbPath, ...args);
}

function runCliIn(cwd, dbPath, ...args) {
  return execFileSync(NODE, [CLI, '--db', dbPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

test('CLI can create spaces, subscribe, remember, and search', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(dbPath, 'subscribe', 'Jevons', 'Project A');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    'test_url: https://test.example.com'
  );

  const result = runCli(dbPath, 'search', 'Jevons', 'test_url');

  assert.match(result, /https:\/\/test\.example\.com/);
});

test('CLI can observe git diff into project context', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');
  const repoPath = mkdtempSync(join(tmpdir(), 'fuli-cli-repo-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fuli@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Fuli Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'prd.md'), '# Project A\n', 'utf8');
  execFileSync('git', ['add', 'prd.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoPath, stdio: 'ignore' });
  writeFileSync(join(repoPath, 'prd.md'), '# Project A\ntest_url: https://diff.example.com\n', 'utf8');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(dbPath, 'subscribe', 'Jevons', 'Project A');

  const observed = runCliIn(repoPath, dbPath, 'observe', 'Jevons', '--target', 'Project A');
  const result = runCli(dbPath, 'search', 'Jevons', 'diff.example');

  assert.match(observed, /observed 1 change/);
  assert.match(result, /https:\/\/diff\.example\.com/);
});

test('CLI can apply a lightweight candidate decision', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'chat',
    '--text',
    'local_alias: pnpm dev'
  );

  const candidates = runCli(dbPath, 'candidates', 'Jevons');
  const candidateId = candidates.trim().split(/\s+/)[0];
  const decision = runCli(dbPath, 'candidate', candidateId, 'personal_only');
  const result = runCli(dbPath, 'search', 'Jevons', 'local_alias');

  assert.match(decision, /candidate personal_only/);
  assert.match(result, /pnpm dev/);
});

test('CLI can print current project rules', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    '禁止: eval\napi_base: https://api.example.com'
  );

  const rules = runCli(dbPath, 'rules', 'Project A');

  assert.match(rules, /forbids eval/);
  assert.match(rules, /api_base https:\/\/api\.example\.com/);
});

test('CLI can publish natural project forbidden rules', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    '这个项目不要用 Redux'
  );

  const rules = runCli(dbPath, 'rules', 'Project A');

  assert.match(rules, /forbids Redux/);
});

test('CLI can print history for one project parameter', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    'test_url: https://old.example.com'
  );
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    'test_url: https://new.example.com'
  );

  const history = runCli(dbPath, 'history', 'Project A', 'test_url');

  assert.match(history, /historical test_url https:\/\/old\.example\.com/);
  assert.match(history, /current test_url https:\/\/new\.example\.com/);
});

test('CLI can print a compact agent context pack', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(dbPath, 'subscribe', 'Jevons', 'Project A');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    '禁止: eval\ntest_url: https://pack.example.com'
  );
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'chat',
    '--text',
    'local_alias: pnpm dev'
  );

  const pack = runCli(dbPath, 'context', 'Jevons', 'Project A', 'test_url');

  assert.match(pack, /Context Jevons -> Project A/);
  assert.match(pack, /Rules/);
  assert.match(pack, /forbids eval/);
  assert.match(pack, /Matches/);
  assert.match(pack, /test_url https:\/\/pack\.example\.com/);
  assert.match(pack, /Candidates 1/);
});

test('CLI context pack prints replacement history when a matched fact changed', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-')), 'fuli.db');

  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(dbPath, 'subscribe', 'Jevons', 'Project A');
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    'test_url: https://old.example.com'
  );
  runCli(
    dbPath,
    'remember',
    'Jevons',
    '--target',
    'Project A',
    '--source-kind',
    'prd',
    '--text',
    'test_url: https://new.example.com'
  );

  const pack = runCli(dbPath, 'context', 'Jevons', 'Project A', 'test_url');

  assert.match(pack, /Matches/);
  assert.match(pack, /test_url https:\/\/new\.example\.com/);
  assert.match(pack, /History/);
  assert.match(pack, /historical test_url https:\/\/old\.example\.com/);
  assert.match(pack, /current test_url https:\/\/new\.example\.com/);
});

test('CLI uses the system SQLite path without --db', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-default-'));
  const dataRoot = join(cwd, 'system-data');
  const dataEnv = process.platform === 'win32'
    ? { LOCALAPPDATA: dataRoot }
    : { XDG_DATA_HOME: dataRoot };

  const output = execFileSync(NODE, [CLI, 'search', '我', 'missing'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...dataEnv }
  });

  assert.match(output, /没有找到相关当前事实/);
  const productDir = process.platform === 'win32' ? 'Fuli' : 'fuli';
  assert.equal(existsSync(join(dataRoot, productDir, 'context.db')), true);
  assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
});

test('CLI honors database and active personal space environment options', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-env-'));
  const dbPath = join(cwd, 'env.db');

  const output = execFileSync(NODE, [CLI, 'search', 'Jevons', 'missing'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FULI_DB_PATH: dbPath, FULI_PERSONAL_SPACE: 'Jevons' }
  });

  assert.match(output, /没有找到相关当前事实/);
  const store = new SqliteStore(dbPath);
  assert.equal(store.findSpaceByName('Jevons').kind, 'personal');
  store.close();
});

test('CLI rejects a live JSON path without modifying it and suggests migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-cli-json-'));
  const dbPath = join(dir, 'legacy.JSON');
  const original = '{"legacy":true}\n';
  writeFileSync(dbPath, original, 'utf8');

  const result = spawnSync(NODE, [CLI, '--db', dbPath, 'search', '我', 'test'], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr,
    /node src\/cli\.js migrate --from .*legacy\.JSON["']? --to .*legacy\.db["']?/);
  assert.equal(readFileSync(dbPath, 'utf8'), original);
});

test('CLI help and migrate do not create the default live database', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-no-live-'));
  const source = join(cwd, 'legacy.json');
  const destination = join(cwd, 'import.db');
  writeFileSync(source, JSON.stringify({
    version: 1,
    spaces: [], subscriptions: [], episodes: [], facts: [], candidates: [], outbox: []
  }), 'utf8');

  execFileSync(NODE, [CLI, '--help'], { cwd, encoding: 'utf8' });
  execFileSync(NODE, [CLI, 'migrate', '--from', source, '--to', destination], {
    cwd,
    encoding: 'utf8'
  });

  assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
});

test('a failing CLI command releases SQLite for a later writer', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-close-')), 'context.db');
  const result = spawnSync(NODE, [CLI, '--db', dbPath, 'unknown'], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  const store = new SqliteStore(dbPath);
  assert.doesNotThrow(() => store.createSpace('After failure', 'public'));
  store.close();
});

test('CLI candidate list omits raw episode text', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-candidate-')), 'context.db');
  runCli(dbPath, 'space', 'create', 'Jevons', '--kind', 'personal');
  runCli(dbPath, 'space', 'create', 'Project A', '--kind', 'public');
  runCli(dbPath, 'remember', 'Jevons', '--target', 'Project A', '--source-kind', 'chat',
    '--text', 'private raw candidate body');

  const output = runCli(dbPath, 'candidates', 'Jevons');

  assert.equal(output.includes('private raw candidate body'), false);
});

test('CLI preserves runtime-looking tokens inside command arguments', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-cli-literal-')), 'context.db');

  const output = runCli(dbPath, 'search', '我', 'literal', '--db', '--personal-space', 'value');

  assert.match(output, /没有找到相关当前事实/);
});

test('CLI help states that global runtime flags belong before the command', () => {
  const help = execFileSync(NODE, [CLI, '--help'], { encoding: 'utf8' });

  assert.match(help, /Global options must appear before the command/);
});

test('unknown CLI commands fail before creating the default database', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-unknown-'));
  const result = spawnSync(NODE, [CLI, 'serach', '我', 'query'], {
    cwd,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command: serach/);
  assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
});

test('CLI accepts a command name as an explicitly disambiguated database path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-command-db-'));
  const help = execFileSync(NODE, [CLI, '--db', 'search', '--help'], {
    cwd,
    encoding: 'utf8'
  });
  assert.match(help, /Commands:/);
  assert.equal(existsSync(join(cwd, 'search')), false);

  const output = execFileSync(NODE, [CLI, '--db', 'search', 'search', '我', 'query'], {
    cwd,
    encoding: 'utf8'
  });
  assert.match(output, /没有找到相关当前事实/);
  assert.equal(existsSync(join(cwd, 'search')), true);
});
