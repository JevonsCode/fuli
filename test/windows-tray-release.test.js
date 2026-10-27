import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { windowsInstallationFixture as fixture } from './fixtures/windows-installation.js';
import { packageWindowsTrayRelease } from '../scripts/package-windows-tray-release.js';
import { downloadWindowsTrayRelease, trayArchiveName, trayChecksumLine } from '../src/desktop/windows-tray-release.js';
import { sha256Bytes } from '../src/security/digest.js';

// The release's Windows tray package: downloaded from the release, checked
// against its published digest, unpacked and checked file by file against the
// candidate's own inventory. Synthetic packages; nothing reaches the network.

const ARCHIVE = Buffer.from('synthetic tray archive');

function release(files) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = files[url];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  };
  return { fetchImpl, requested };
}

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-tray-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The release asset .github/workflows/release.yml attaches.
const url = (version, suffix = '') => `https://github.com/JevonsCode/fuli/releases/download/v${version}/fuli-windows-tray-${version}.zip${suffix}`;

test('a verified tray package is unpacked and returned only after its digest, inventory and version match', async (t) => {
  const f = fixture(t);
  const name = trayArchiveName('0.12.4');
  const { fetchImpl, requested } = release({ [url('0.12.4')]: ARCHIVE,
    [url('0.12.4', '.sha256')]: trayChecksumLine(sha256Bytes(ARCHIVE), name) });
  const steps = [];
  const directory = scratch(t);
  const source = await downloadWindowsTrayRelease('0.12.4', directory, { fetchImpl, progress: (step) => steps.push(step),
    extract: async (archive, target) => {
      assert.deepEqual(readFileSync(archive), ARCHIVE);
      cpSync(f.source, target, { recursive: true });
    } });
  assert.equal(source, join(directory, 'package'));
  assert.deepEqual(steps, ['downloading', 'verifying']);
  assert.deepEqual(requested, [url('0.12.4', '.sha256'), url('0.12.4')]);
});

test('a digest mismatch, a missing package, another version or a changed file is refused', async (t) => {
  const f = fixture(t);
  const name = trayArchiveName('0.12.4');
  const copy = async (_archive, target) => cpSync(f.source, target, { recursive: true });
  const wrongDigest = release({ [url('0.12.4')]: ARCHIVE, [url('0.12.4', '.sha256')]: trayChecksumLine('0'.repeat(64), name) });
  await assert.rejects(downloadWindowsTrayRelease('0.12.4', scratch(t), { ...wrongDigest, extract: copy }), /published checksum/);
  await assert.rejects(downloadWindowsTrayRelease('0.12.4', scratch(t), { ...release({}), extract: copy }), /no Windows package/);
  const published = { [url('0.12.5')]: ARCHIVE, [url('0.12.5', '.sha256')]: trayChecksumLine(sha256Bytes(ARCHIVE), trayArchiveName('0.12.5')) };
  await assert.rejects(downloadWindowsTrayRelease('0.12.5', scratch(t), { ...release(published), extract: copy }), /contains v0\.12\.4/);
  const good = { [url('0.12.4')]: ARCHIVE, [url('0.12.4', '.sha256')]: trayChecksumLine(sha256Bytes(ARCHIVE), name) };
  await assert.rejects(downloadWindowsTrayRelease('0.12.4', scratch(t), { ...release(good), extract: async (archive, target) => {
    await copy(archive, target);
    writeFileSync(join(target, 'src', 'cli.js'), 'changed');
  } }), /checksum mismatch: src\/cli\.js/);
  await assert.rejects(downloadWindowsTrayRelease('../../evil', scratch(t), release({})), /version/i);
});

// macOS tmpdir() is /var/..., a link to /private/var/...; a redirected Windows
// TEMP is a junction. The package is checked against its resolved files, so a
// download directory reached through a link is accepted and a file linked out
// of the package is still refused.
test('a package reached through a directory link is verified against its resolved files', async (t) => {
  const f = fixture(t);
  const name = trayArchiveName('0.12.4');
  const real = scratch(t);
  // The link is removed by itself before its parent, so no cleanup follows it.
  const holder = mkdtempSync(join(tmpdir(), 'fuli-tray-release-link-'));
  const linked = join(holder, 'linked');
  symlinkSync(real, linked, 'junction');
  t.after(() => { unlinkSync(linked); rmSync(holder, { recursive: true, force: true }); });
  const good = { [url('0.12.4')]: ARCHIVE, [url('0.12.4', '.sha256')]: trayChecksumLine(sha256Bytes(ARCHIVE), name) };
  const copy = async (_archive, target) => cpSync(f.source, target, { recursive: true });
  assert.equal(await downloadWindowsTrayRelease('0.12.4', linked, { ...release(good), extract: copy }), join(linked, 'package'));
  if (process.platform === 'win32') return; // File links need a privilege Windows runners may lack.
  const outside = join(scratch(t), 'cli.js');
  writeFileSync(outside, readFileSync(join(f.source, 'src', 'cli.js')));
  const escaped = join(scratch(t), 'escaped');
  mkdirSync(escaped);
  await assert.rejects(downloadWindowsTrayRelease('0.12.4', escaped, { ...release(good), extract: async (archive, target) => {
    await copy(archive, target);
    unlinkSync(join(target, 'src', 'cli.js'));
    symlinkSync(outside, join(target, 'src', 'cli.js'));
  } }), /checksum mismatch: src\/cli\.js/);
});

test('the release script\'s zip round-trips through the update download', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t);
  const output = scratch(t);
  const packaged = await packageWindowsTrayRelease({ tray: f.source, output });
  assert.equal(packaged.version, '0.12.4');
  const files = { [url('0.12.4')]: readFileSync(packaged.archive), [url('0.12.4', '.sha256')]: readFileSync(packaged.checksum, 'utf8') };
  const source = await downloadWindowsTrayRelease('0.12.4', scratch(t), release(files));
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), readFileSync(join(f.source, 'package.json'), 'utf8'));
});
