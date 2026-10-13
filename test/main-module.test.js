import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/system/main-module.js';

test('entry detection follows a symlinked install directory such as nvm-windows', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-main-module-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'entry.js'), '');
  writeFileSync(join(real, 'other.js'), '');
  symlinkSync(real, join(root, 'linked'), 'junction');

  // Node reports import.meta.url by real path; the host keeps the linked path in argv.
  const metaUrl = pathToFileURL(join(real, 'entry.js')).href;
  assert.equal(isMainModule(metaUrl, join(root, 'linked', 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, join(real, 'entry.js')), true);
  assert.equal(isMainModule(metaUrl, join(root, 'linked', 'other.js')), false);
  assert.equal(isMainModule(metaUrl, join(root, 'missing.js')), false);
  assert.equal(isMainModule(metaUrl, undefined), false);
});
