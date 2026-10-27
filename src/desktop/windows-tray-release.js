import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256File } from '../security/digest.js';
import { parseSemanticVersion } from '../semantic-version.js';
import { trayInventory } from './windows-installation.js';

// What a GitHub release publishes for the per-user Windows (tray) install:
// the tray candidate as one zip with its SHA-256 beside it
// (.github/workflows/release.yml runs scripts/package-windows-tray-release.js).

const TRAY_RELEASE_BASE_URL = 'https://github.com/JevonsCode/fuli/releases/download';
export const trayArchiveName = version => `fuli-windows-tray-${version}.zip`;
// The sha256sum format: "<hex>  <file name>".
export const trayChecksumLine = (digest, name) => `${digest}  ${name}\n`;

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const CHECKSUM_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;

// Downloads one release's tray candidate into directory (new and empty) and
// returns the extracted package directory once the archive matches its
// published digest, every file matches the candidate's own inventory, and the
// candidate is the version asked for. progress(step) names the real step.
export async function downloadWindowsTrayRelease(version, directory, {
  fetchImpl = globalThis.fetch, extract = extractZip, progress = () => {}
} = {}) {
  parseSemanticVersion(version);
  const name = trayArchiveName(version);
  const url = `${TRAY_RELEASE_BASE_URL}/v${version}/${name}`;
  progress('downloading');
  const expected = await publishedDigest(url + '.sha256', name, version, fetchImpl);
  const archive = join(directory, name);
  await download(url, archive, version, fetchImpl);
  progress('verifying');
  if (await sha256File(archive) !== expected) {
    throw new Error(`The downloaded Windows package for v${version} does not match its published checksum; nothing was installed.`);
  }
  const source = join(directory, 'package');
  mkdirSync(source);
  await extract(archive, source);
  const packaged = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (packaged !== version) throw new Error(`The Windows package for v${version} contains v${packaged}; nothing was installed.`);
  trayInventory(source);
  return source;
}

async function fetchRelease(url, version, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) throw new Error(`Release v${version} has no Windows package to update from yet.`);
  if (!response.ok) throw new Error(`The Windows package for v${version} could not be downloaded (HTTP ${response.status}).`);
  return response;
}

async function publishedDigest(url, name, version, fetchImpl) {
  const text = await (await fetchRelease(url, version, fetchImpl, CHECKSUM_TIMEOUT_MS)).text();
  const match = /^([a-f0-9]{64}) [ *](\S+)\s*$/.exec(text.split(/\r?\n/)[0] ?? '');
  if (!match || match[2] !== name) throw new Error(`The published checksum of the Windows package for v${version} is not readable.`);
  return match[1];
}

async function download(url, path, version, fetchImpl) {
  const response = await fetchRelease(url, version, fetchImpl, DOWNLOAD_TIMEOUT_MS);
  let received = 0;
  await pipeline(Readable.fromWeb(response.body), async function* limit(source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) throw new Error(`The Windows package for v${version} is larger than expected; nothing was installed.`);
      yield chunk;
    }
  }, createWriteStream(path, { flags: 'wx' }));
}

// Windows' own tar reads zip archives and refuses absolute or parent paths.
function extractZip(archive, target) {
  return new Promise((resolve, reject) => {
    execFile(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', target],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
      error => error ? reject(new Error('The Windows package could not be unpacked; nothing was installed.')) : resolve());
  });
}
