import assert from 'node:assert/strict';
import test from 'node:test';
import { checksumDigest, previousRelease } from '../acceptance/windows-installed-update.js';

test('the newest published release with a tray asset includes prereleases and excludes drafts', () => {
  const release = (version, published_at, options = {}) => ({ tag_name: `v${version}`, published_at,
    draft: !!options.draft, prerelease: !!options.prerelease,
    assets: options.noAsset ? [] : [{ name: `fuli-windows-tray-${version}.zip` }] });
  assert.deepEqual(previousRelease([[release('1.2.0', '2026-01-01'), release('1.3.0', '2026-04-01', { draft: true })],
    [release('1.2.2', '2026-03-01', { noAsset: true }), release('1.2.1-beta.1', '2026-02-01', { prerelease: true })]]),
  { tag: 'v1.2.1-beta.1', version: '1.2.1-beta.1', archive: 'fuli-windows-tray-1.2.1-beta.1.zip' });
  assert.throws(() => previousRelease([[release('1.2.0', '2026-01-01', { noAsset: true })]]), /No published release/);
});

test('published checksum must name the exact archive and contain a SHA-256', () => {
  const digest = 'a'.repeat(64);
  assert.equal(checksumDigest(`${digest}  fuli.zip\n`, 'fuli.zip'), digest);
  assert.throws(() => checksumDigest(`${digest}  other.zip\n`, 'fuli.zip'), /checksum/);
  assert.throws(() => checksumDigest('bad  fuli.zip\n', 'fuli.zip'), /checksum/);
});
