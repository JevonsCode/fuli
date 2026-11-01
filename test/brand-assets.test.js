import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { brandAssets, PROJECT_ROOT, writeBrandAssets } from '../scripts/build-brand-assets.js';
import { encodePng } from '../scripts/brand/png.js';

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-brand-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// A synthetic 8 x 8 logo: a gradient with a transparent corner.
function syntheticLogo() {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let at = 0; at < size * size; at++) {
    data.set([at * 4, 255 - at * 4, 90, at === 0 ? 0 : 255], at * 4);
  }
  return encodePng({ width: size, height: size, data });
}

test('every checked-in copy of the logo matches brand/fuli-logo.png', () => {
  withTempDir((directory) => {
    const assets = brandAssets();
    assert.deepEqual(writeBrandAssets(directory, assets), assets.map(({ path }) => path));
    const stale = assets
      .filter(({ path, same }) => !same(readFileSync(join(PROJECT_ROOT, path)), readFileSync(join(directory, path))))
      .map(({ path }) => path);
    assert.deepEqual(stale, [], 'brand/fuli-logo.png changed: run `node scripts/build-brand-assets.js`');
  });
});

test('the generator gives byte-identical files for the same logo', () => {
  const logo = syntheticLogo();
  const first = brandAssets(logo);
  const second = brandAssets(logo);
  assert.ok(first.length > 0);
  first.forEach(({ path, bytes }, index) => {
    assert.equal(second[index].path, path);
    assert.ok(bytes.equals(second[index].bytes), path);
  });
});

test('regenerating rewrites only the copies that no longer match', () => {
  withTempDir((directory) => {
    const assets = brandAssets(syntheticLogo());
    writeBrandAssets(directory, assets);
    assert.deepEqual(writeBrandAssets(directory, assets), []);

    const copy = assets[0];
    const icon = assets.find(({ path }) => path.endsWith('.ico'));
    writeFileSync(join(directory, copy.path), Buffer.from('an older logo'));
    writeFileSync(join(directory, icon.path), Buffer.from('an older icon'));
    assert.deepEqual(writeBrandAssets(directory, assets), [copy.path, icon.path]);
    assert.ok(readFileSync(join(directory, copy.path)).equals(copy.bytes));
    assert.ok(readFileSync(join(directory, icon.path)).equals(icon.bytes));
  });
});
