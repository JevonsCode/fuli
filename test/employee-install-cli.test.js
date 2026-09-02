import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const manifest = {
  schemaVersion: 1, id: 'fixture-reviewer', version: '1.0.0',
  name: 'Fixture reviewer', role: 'Reviewer', description: 'Synthetic installation fixture.',
  occupationEmoji: '🔎', capabilities: ['review'], workKinds: ['review'],
  initialPreferences: [], permissions: [], runtime: null
};

test('employee install rejects a receipt symlink without overwriting a file outside the package', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside.txt');
  writeFileSync(outside, 'synthetic file must stay unchanged');
  symlinkSync(outside, join(f.source, '.installation.json'));

  const result = f.install();

  assert.equal(readFileSync(outside, 'utf8'), 'synthetic file must stay unchanged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlinks/);
});

test('employee install includes nested receipt-named assets in package identity', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'assets'));
  const asset = join(f.source, 'assets', '.installation.json');
  writeFileSync(asset, 'first synthetic asset');
  assert.equal(f.install().status, 0);
  writeFileSync(asset, 'changed synthetic asset');

  const result = f.install();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /package already exists.*--replace/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-employee-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'employee.json'), JSON.stringify(manifest));
  return {
    root, source,
    install: (options = []) => spawnSync(process.execPath, [
      cli, 'employee', 'install', source,
      '--runtime-config', join(root, 'host', 'runtime.json'), ...options
    ], { cwd: root, env: {}, encoding: 'utf8', timeout: 10_000 })
  };
}
