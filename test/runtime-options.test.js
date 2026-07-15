import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  openLocalApplication,
  quoteShellArgument,
  resolveRuntimeOptions,
  resolveStore
} from '../src/runtime-options.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

const execFileAsync = promisify(execFile);

test('runtime options and setup use the same system SQLite default', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-runtime-default-'));
  const env = process.platform === 'win32'
    ? { LOCALAPPDATA: root }
    : { XDG_DATA_HOME: root };
  assert.deepEqual(resolveRuntimeOptions([], env), {
    dbPath: resolveSetupPaths({ env }).dbPath,
    personalSpaceName: '我'
  });
});

test('environment configures runtime options when CLI flags are absent', () => {
  assert.deepEqual(resolveRuntimeOptions([], {
    FULI_DB_PATH: 'env.db',
    FULI_PERSONAL_SPACE: 'Jevons'
  }), {
    dbPath: 'env.db',
    personalSpaceName: 'Jevons'
  });
});

test('CLI runtime flags take priority over environment values', () => {
  const result = resolveRuntimeOptions([
    '--db', 'cli.db', '--personal-space', 'CLI User'
  ], {
    FULI_DB_PATH: 'env.db',
    FULI_PERSONAL_SPACE: 'Env User'
  });

  assert.deepEqual(result, { dbPath: 'cli.db', personalSpaceName: 'CLI User' });
});

test('runtime options allow values that happen to be CLI command names', () => {
  assert.equal(resolveRuntimeOptions(['--db', 'search'], {}).dbPath, 'search');
  assert.equal(resolveRuntimeOptions(['--personal-space', 'search'], {}).personalSpaceName,
    'search');
});

test('implicit default refuses to hide an unmigrated legacy JSON database', () => {
  const cwd = resolve('workspace', 'project');
  const legacyPath = join(cwd, '.fuli', 'context.json');
  const dbPath = join(cwd, '.fuli', 'context.db');
  const existing = new Set([legacyPath]);
  const fsOptions = { cwd, existsSync: (path) => existing.has(path) };

  assert.throws(
    () => resolveRuntimeOptions([], {}, fsOptions),
    /node src\/cli\.js migrate --from .*context\.json.* --to .*context\.db/
  );

  existing.add(dbPath);
  assert.deepEqual(resolveRuntimeOptions([], {}, fsOptions).dbPath, '.fuli/context.db');
});

test('explicit CLI or environment default database bypasses the legacy guard', () => {
  const fsOptions = { cwd: 'project', existsSync: () => true };

  assert.equal(resolveRuntimeOptions(['--db', '.fuli/context.db'], {}, fsOptions).dbPath,
    '.fuli/context.db');
  assert.equal(resolveRuntimeOptions([], { FULI_DB_PATH: '.fuli/context.db' }, fsOptions).dbPath,
    '.fuli/context.db');
});

test('runtime flags require non-empty values', () => {
  for (const args of [
    ['--db'],
    ['--db', '--personal-space', 'Me'],
    ['--personal-space', ''],
    ['--db', '   ']
  ]) {
    assert.throws(() => resolveRuntimeOptions(args, {}), /Missing value for --/);
  }
  assert.throws(
    () => resolveRuntimeOptions([], { FULI_DB_PATH: '' }),
    /FULI_DB_PATH must not be empty/
  );
});

test('duplicate runtime flags are rejected after validating every value', () => {
  for (const flag of ['--db', '--personal-space']) {
    assert.throws(
      () => resolveRuntimeOptions([flag, 'first', flag, 'second'], {}),
      new RegExp(`Duplicate ${flag}`)
    );
    assert.throws(
      () => resolveRuntimeOptions([flag, 'first', flag], {}),
      new RegExp(`Missing value for ${flag}`)
    );
    assert.throws(
      () => resolveRuntimeOptions([flag, 'first', flag, ''], {}),
      new RegExp(`Missing value for ${flag}`)
    );
  }
});

test('JSON live paths are rejected with one migration command and left unchanged', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fuli-runtime-json-')), 'legacy.json');
  const original = '{"legacy":true}\n';
  writeFileSync(path, original, 'utf8');

  assert.throws(
    () => resolveStore({ dbPath: path }),
    (error) => {
      assert.equal((error.message.match(/node src\/cli\.js migrate/g) ?? []).length, 1);
      assert.match(error.message, /--from .*legacy\.json["']? --to .*legacy\.db["']?/);
      return true;
    }
  );
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('JSON live-path rejection is case insensitive', () => {
  assert.throws(() => resolveStore({ dbPath: 'CONTEXT.JsOn' }), /migrate/);
});

test('JSON rejection provides an executable migration command for paths with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli runtime migrate '));
  const directory = join(root, 'legacy data');
  const source = join(directory, 'context source.json');
  const destination = join(directory, 'context source.db');
  mkdirSync(directory);
  const original = JSON.stringify({
    version: 1,
    spaces: [], subscriptions: [], episodes: [], facts: [], candidates: [], outbox: []
  });
  writeFileSync(source, original, 'utf8');

  let command;
  assert.throws(() => resolveStore({ dbPath: source }), (error) => {
    command = error.message.match(/Run once: (.+)$/)?.[1];
    return Boolean(command);
  });
  execSync(command, { cwd: process.cwd(), stdio: 'pipe' });

  assert.equal(existsSync(destination), true);
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('shell argument quoting follows Windows and POSIX path rules', () => {
  assert.equal(quoteShellArgument('C:\\data path\\context.json', 'win32'),
    '"C:\\data path\\context.json"');
  assert.throws(() => quoteShellArgument('C:\\bad"path', 'win32'), /double quote/);
  assert.equal(quoteShellArgument("/tmp/user's context.json", 'linux'),
    "'/tmp/user'\\''s context.json'");
});

test('shared local application bootstrap is safe across concurrent first opens', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-runtime-open-')), 'context.db');
  const script = `
    import { openLocalApplication } from './src/runtime-options.js';
    const app = openLocalApplication({ dbPath: process.argv[1], personalSpaceName: 'Jevons' });
    app.close();
  `;
  await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
    '--input-type=module', '--eval', script, dbPath
  ])));
  const app = openLocalApplication({ dbPath, personalSpaceName: 'Jevons' });

  try {
    assert.equal(app.requireActivePersonalSpace().name, 'Jevons');
    assert.deepEqual(app.state().spaces.map(({ name }) => name), ['Jevons', '工作']);
  } finally {
    app.close();
  }
});
