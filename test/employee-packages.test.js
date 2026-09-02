import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEmployeePackage } from '../src/employees/install-package.js';
import { createEmployeePackageRegistry, employeeDirectories } from '../src/employees/package-registry.js';
import { parseEmployeeManifest } from '../src/employees/manifest.js';

const original = JSON.parse(readFileSync(new URL('../src/employees/catalog/jefa.json', import.meta.url)));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-employees-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(join(source, 'runtime'), { recursive: true });
  mkdirSync(join(source, 'web'));
  writeFileSync(join(source, 'employee.json'), JSON.stringify(original));
  writeFileSync(join(source, 'web/index.html'), '<h1>Fixture only</h1>');
  writeFileSync(join(source, 'runtime/index.mjs'), 'export const createEmployeeRuntime = () => ({ handleHttp() {}, callTool() {}, describeTools() { return [] }, close() {} });');
  return { root, source, runtimeConfigPath: join(root, 'host/runtime.json') };
}

test('local packages install idempotently, back up upgrades, and keep state separate', async (t) => {
  const f = fixture(t);
  const first = installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath });
  assert.equal(first.idempotent, false);
  assert.equal(installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath }).idempotent, true);
  writeFileSync(join(f.source, 'web/index.html'), '<h1>Updated fixture</h1>');
  assert.throws(() => installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath }), { code: 'package_exists' });
  assert.equal(installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath, replace: true }).backupCreated, true);
  const dirs = employeeDirectories(f.runtimeConfigPath);
  assert.equal(readdirSync(dirs.packageDirectory).filter((name) => name.includes('.backup-')).length, 1);
  const registry = createEmployeePackageRegistry(dirs);
  t.after(() => registry.close());
  assert.equal(registry.get('jefa').runtimeStatus, 'ready');
  const runtime = await registry.runtime('jefa');
  assert.deepEqual(runtime.describeTools(), []);
  assert.equal(await registry.runtime('jefa'), runtime);
});

test('a second employee uses the same catalog protocol without a Jefa branch', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'employee.json'), JSON.stringify({ ...original, id: 'release-reviewer', name: 'Release reviewer', role: 'Reviewer', runtime: null, permissions: ['release.read'] }));
  installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath });
  const registry = createEmployeePackageRegistry(employeeDirectories(f.runtimeConfigPath));
  assert.equal(registry.get('release-reviewer').runtimeStatus, 'not_required');
  assert.equal(registry.catalog().length, 2);
});

test('a stale installation receipt cannot hide a modified runtime', (t) => {
  const f = fixture(t);
  installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath });
  const target = join(employeeDirectories(f.runtimeConfigPath).packageDirectory, 'jefa');
  writeFileSync(join(target, 'runtime/index.mjs'), 'throw new Error("modified fixture");');
  assert.throws(() => installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath }), { code: 'package_exists' });
  assert.equal(installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath, replace: true }).backupCreated, true);
});

test('package traversal, credential files, and symlinks are refused without importing code', (t) => {
  const f = fixture(t);
  assert.throws(() => parseEmployeeManifest({ ...original, runtime: { ...original.runtime, entry: '../outside.mjs' } }));
  writeFileSync(join(f.source, '.env'), 'EXAMPLE=fixture');
  assert.throws(() => installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath }), /built artifacts/);
  rmSync(join(f.source, '.env'));
  symlinkSync(join(f.source, 'runtime/index.mjs'), join(f.source, 'linked.mjs'));
  assert.throws(() => installEmployeePackage({ sourceDirectory: f.source, runtimeConfigPath: f.runtimeConfigPath }), /symlinks/);
});
