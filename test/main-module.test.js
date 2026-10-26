import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/system/main-module.js';
import { CHILD_HANG_GUARD_MS } from '../test-support/child-process-guard.js';

function linkedInstall(t, target = null) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-main-module-'));
  const real = target ?? join(root, 'real');
  if (!target) mkdirSync(real);
  const linked = join(root, 'linked install');
  symlinkSync(real, linked, 'junction');
  t.after(() => {
    unlinkSync(linked);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, real, linked };
}

test('entry detection follows a linked install directory such as nvm-windows', (t) => {
  const { root, real, linked } = linkedInstall(t);
  writeFileSync(join(real, 'entry.js'), '');
  writeFileSync(join(real, 'other.js'), '');
  const metaUrl = pathToFileURL(join(real, 'entry.js')).href;
  assert.equal(isMainModule(metaUrl, join(linked, 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, join(real, 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, join(linked, 'other.js')), false);
  assert.equal(isMainModule(metaUrl, join(root, 'missing.js')), false);
  assert.equal(isMainModule(metaUrl, ''), false);
  assert.equal(isMainModule(metaUrl, null), false);
});

test('a missing argv path falls back to an exact resolved comparison', () => {
  const missing = join(tmpdir(), 'fuli-main-module-absent', 'entry.js');
  assert.equal(isMainModule(pathToFileURL(missing).href, missing), true);
  assert.equal(isMainModule(pathToFileURL(missing).href, `${missing}.other`), false);
});

test('an entry started through the linked path runs its main block', (t) => {
  const { root, real, linked } = linkedInstall(t);
  const helper = pathToFileURL(resolve('src/system/main-module.js')).href;
  writeFileSync(join(real, 'entry.mjs'), `import { isMainModule } from ${JSON.stringify(helper)};\n`
    + "if (isMainModule(import.meta.url, process.argv[1])) process.stdout.write('main');\n");
  assert.equal(execFileSync(process.execPath, [join(linked, 'entry.mjs')], { encoding: 'utf8' }), 'main');
  assert.equal(execFileSync(process.execPath, [join('linked install', 'entry.mjs')], { cwd: root, encoding: 'utf8' }), 'main');
});

for (const [host, folder, event] of [
  ['Codex', 'codex', 'UserPromptSubmit'],
  ['Claude', 'claude-code', 'UserPromptSubmit'],
  ['Cursor', 'cursor', 'beforeSubmitPrompt']
]) test(`${host} Hook started through a linked install emits its entry output`, (t) => {
  const { root, real, linked } = linkedInstall(t, process.cwd());
  const run = base => spawnSync(process.execPath, [join(base, 'src', 'agents', folder, 'lifecycle-hook.js'),
    '--event', event, '--runtime-config', join(root, 'private-missing.json')], {
    input: '{PRIVATE_INVALID_INPUT', encoding: 'utf8', timeout: CHILD_HANG_GUARD_MS
  });
  const direct = run(real), throughLink = run(linked);
  assert.equal(direct.status, 0);
  assert.equal(throughLink.status, 0);
  assert.equal(throughLink.stderr, '');
  assert.ok(throughLink.stdout.trim(), 'the native hook must not silently skip its main block');
  assert.deepEqual(JSON.parse(throughLink.stdout), JSON.parse(direct.stdout));
  assert.doesNotMatch(throughLink.stdout, /PRIVATE_INVALID_INPUT|private-missing/);
});

for (const [name, path, failure] of [
  ['server', 'src/server.js', /Missing or invalid value for --port/],
  ['setup', 'src/graphiti/setup.js', /--port must be a positive integer/],
  ['site', 'scripts/build-site.js', /SYNTHETIC_SITE_COPY/]
]) test(`${name} linked entry runs its main block while importing stays inert`, t => {
  const { root, real, linked } = linkedInstall(t, process.cwd());
  const dataDir = join(root, 'isolated');
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  // Validation stops server/setup before application creation or setup writes.
  const args = name === 'server' ? ['--runtime-config', runtimeConfigPath, '--port', 'invalid']
    : name === 'setup' ? ['--data-dir', dataDir, '--no-start', '--personal-only', '--port', 'invalid'] : [];
  const stub = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url === 'node:fs/promises') return { format: 'module', shortCircuit: true,
        source: 'export const cp = async function blockedSiteWrite() { throw new Error("SYNTHETIC_SITE_COPY"); }; export const mkdir = cp, readFile = cp, writeFile = cp;' };
      return nextLoad(url, context);
    } });
    if ((await import('node:fs/promises')).cp.name !== 'blockedSiteWrite') throw new Error('Site IO stub unavailable');`;
  // Verify the write stub before loading the real site entry. No repository
  // site assets or dist output are copied, read or modified by buildSite.
  const nodeArgs = name === 'site' ? ['--import', `data:text/javascript,${encodeURIComponent(stub)}`] : [];
  const options = { cwd: root, env: { ...process.env, FULI_GRAPH_RUNTIME_CONFIG: runtimeConfigPath },
    encoding: 'utf8', timeout: CHILD_HANG_GUARD_MS };
  for (const base of [real, linked]) {
    const result = spawnSync(process.execPath, [...nodeArgs, join(base, path), ...args], options);
    assert.equal(result.status, 1, `${name} main must reach the isolated stop condition`);
    assert.match(result.stderr, failure);
    assert.equal(result.stdout, '');
  }
  const probe = join(root, 'import-probe.mjs');
  writeFileSync(probe, `await import(${JSON.stringify(pathToFileURL(join(linked, path)).href)});\n`);
  const imported = spawnSync(process.execPath, [...nodeArgs, probe, ...args], options);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  assert.equal(existsSync(dataDir), false, 'entry/import checks must not create runtime state');
});
