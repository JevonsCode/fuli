import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/system/main-module.js';

function linkedInstall(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-main-module-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'other.js'), '');
  symlinkSync(real, join(root, 'linked'), 'junction');
  return { root, real, linked: join(root, 'linked') };
}

test('entry detection follows a symlinked install directory such as nvm-windows', (t) => {
  const { root, real, linked } = linkedInstall(t);
  writeFileSync(join(real, 'entry.js'), '');

  // Node reports import.meta.url by real path; the host keeps the linked path in argv.
  const metaUrl = pathToFileURL(join(real, 'entry.js')).href;
  assert.equal(isMainModule(metaUrl, join(linked, 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, join(real, 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, relative(process.cwd(), join(linked, 'entry.js'))), true);
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
  const { real, linked } = linkedInstall(t);
  const helper = pathToFileURL(join(process.cwd(), 'src', 'system', 'main-module.js')).href;
  writeFileSync(join(real, 'entry.mjs'), `import { isMainModule } from ${JSON.stringify(helper)};\n`
    + "if (isMainModule(import.meta.url)) process.stdout.write('main');\n");
  assert.equal(execFileSync(process.execPath, [join(linked, 'entry.mjs')], { encoding: 'utf8' }), 'main');
});
