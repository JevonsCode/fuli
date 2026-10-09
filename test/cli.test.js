import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
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
  assert.match(help, /roundtable worker --url URL --room ID --runtime codex\|claude-code\|pi\|grok\|a2a/);
  assert.match(help, /roundtable worker[^\n]*\[--model MODEL\]/);
  assert.doesNotMatch(help, /[\p{Script=Han}]/u);
  assert.doesNotMatch(help, /Legacy local knowledge|space create|migrate --from|--db SQLITE_DB/);
});

test('Roundtable help works before required arguments without creating state or running a worker', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-cli-roundtable-help-'));
  t.after(() => { if (readdirSync(cwd).length === 0) rmdirSync(cwd); });
  const env = { ...process.env, FULI_DATA_DIR: join(cwd, 'data'), FULI_ROUNDTABLE_TOKEN: '' };
  for (const action of [null, 'serve', 'worker']) {
    for (const flag of ['--help', '-h']) {
      const args = ['roundtable', ...(action ? [action] : []), flag];
      const result = spawnSync(NODE, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /--help, -h/);
      if (action === 'serve') {
        assert.match(result.stdout, /^fl roundtable serve/);
        for (const option of ['--data-dir', '--port', '--host', '--public-url']) assert.ok(result.stdout.includes(option));
        assert.doesNotMatch(result.stdout, /--runtime|--room|--allow-write/);
      } else {
        assert.match(result.stdout, /--runtime codex\|claude-code\|pi\|grok\|a2a/);
        for (const option of ['--workspace', '--allow-write', '--model', '--a2a-url', '--once', '--allow-http']) assert.ok(result.stdout.includes(option));
        if (action === 'worker') assert.doesNotMatch(result.stdout, /--data-dir|--port|--host|--public-url/);
      }
    }
  }
  const missingDirectory = spawnSync(NODE, [CLI, 'roundtable', 'serve', '--data-dir', '-h', '--port', '0'],
    { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(missingDirectory.status, 1, missingDirectory.stderr);
  assert.match(missingDirectory.stderr, /Missing --data-dir/);
  assert.equal(missingDirectory.stdout, '', 'invalid help placement must never start a coordinator');
  assert.deepEqual(readdirSync(cwd), []);
});

test('Roundtable help does not bypass unknown actions, unknown options or normal required arguments', () => {
  const cases = [
    { args: ['roundtable', 'unknown', '--help'], error: /Roundtable action must be serve or worker/ },
    { args: ['roundtable', 'worker', '--unknown'], error: /Unknown or duplicate Roundtable option --unknown/ },
    { args: ['roundtable', 'worker', '--unknown', '--help'], error: /Unknown or duplicate Roundtable option --unknown/ },
    { args: ['roundtable', '--help', '--unknown'], error: /Unknown or duplicate Roundtable option --unknown/ },
    { args: ['roundtable', '-h', '--unknown'], error: /Unknown or duplicate Roundtable option --unknown/ },
    { args: ['roundtable', '--help', '--help'], error: /Unknown or duplicate Roundtable option --help/ },
    { args: ['roundtable', '-h', '-h'], error: /Unknown or duplicate Roundtable option -h/ },
    { args: ['roundtable', '--help', '-h'], error: /Unknown or duplicate Roundtable option -h/ },
    { args: ['roundtable', 'worker', '-h', '--help'], error: /Unknown or duplicate Roundtable option --help/ },
    { args: ['roundtable', 'worker', '--once', '--once'], error: /Unknown or duplicate Roundtable option --once/ },
    { args: ['roundtable', 'worker', '--model', '-h-model'], error: /Worker requires --url --room --runtime/ },
    { args: ['roundtable', 'worker'], error: /Worker requires --url --room --runtime/ }
  ];
  for (const { args, error } of cases) {
    const result = spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, error);
  }
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
