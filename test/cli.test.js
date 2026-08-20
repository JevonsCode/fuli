import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { FULI_VERSION } from '../src/package-metadata.js';

const NODE = process.execPath;
const CLI = resolve('src/cli.js');

test('CLI reports the package version', () => {
  const output = execFileSync(NODE, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(output.trim(), FULI_VERSION);
});

test('CLI help exposes only installation and local service commands', () => {
  const help = execFileSync(NODE, [CLI, '--help'], { encoding: 'utf8' });

  assert.match(help, /fuli <command>  \(short alias: fl\)/);
  assert.match(help, /update \[setup options\]/);
  assert.match(help, /graph export --output DIR/);
  assert.match(help, /graph import --input DIR/);
  assert.doesNotMatch(help, /[\p{Script=Han}]/u);
  assert.doesNotMatch(help, /Legacy local knowledge|space create|migrate --from|--db SQLITE_DB/);
});

test('removed SQLite knowledge commands fail without creating a database', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-removed-'));

  for (const command of ['search', 'remember', 'migrate']) {
    const result = spawnSync(NODE, [CLI, command], { cwd, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Unknown command: ${command}`));
  }

  assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
});

test('unknown CLI commands fail without creating local state', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-unknown-'));
  const result = spawnSync(NODE, [CLI, 'serach'], { cwd, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command: serach/);
  assert.equal(existsSync(join(cwd, '.fuli', 'context.db')), false);
});
