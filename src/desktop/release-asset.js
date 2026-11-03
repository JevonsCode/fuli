import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256File } from '../security/digest.js';
import { parseSemanticVersion } from '../semantic-version.js';

// One file a GitHub release publishes for a desktop installation (the Windows
// tray zip, the macOS .dmg) with its SHA-256 beside it, as the one-click
// updates download it. .github/workflows/release.yml attaches both.

const RELEASE_BASE_URL = 'https://github.com/JevonsCode/fuli/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const CHECKSUM_TIMEOUT_MS = 60_000;
const MAX_ASSET_BYTES = 2 * 1024 ** 3;

// The sha256sum format: "<hex>  <file name>".
export const releaseChecksumLine = (digest, name) => `${digest}  ${name}\n`;

// Downloads release v<version>'s file `name` into directory (new and empty)
// and returns its path once it matches the published digest. what names the
// file in messages ("Windows package"). Failures carry .code: 'download_failed'
// or 'checksum_mismatch'.
export async function downloadVerifiedReleaseAsset({ version, name, directory, what }, {
  fetchImpl = globalThis.fetch, progress = () => {}
} = {}) {
  parseSemanticVersion(version);
  const url = `${RELEASE_BASE_URL}/v${version}/${name}`;
  const label = { version, what };
  progress('downloading');
  const expected = await publishedDigest(url + '.sha256', name, label, fetchImpl);
  const path = join(directory, name);
  await download(url, path, label, fetchImpl);
  progress('verifying');
  if (await sha256File(path) !== expected) {
    throw failure(`The downloaded ${what} for v${version} does not match its published checksum; nothing was installed.`,
      'checksum_mismatch');
  }
  return path;
}

export const failure = (message, code) => Object.assign(new Error(message), { code });

async function fetchRelease(url, { version, what }, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw failure(`The ${what} for v${version} could not be downloaded (${error?.message ?? error}).`, 'download_failed');
  }
  if (response.status === 404) throw failure(`Release v${version} has no ${what} to update from yet.`, 'download_failed');
  if (!response.ok) throw failure(`The ${what} for v${version} could not be downloaded (HTTP ${response.status}).`, 'download_failed');
  return response;
}

async function publishedDigest(url, name, label, fetchImpl) {
  const text = await (await fetchRelease(url, label, fetchImpl, CHECKSUM_TIMEOUT_MS)).text();
  const match = /^([a-f0-9]{64}) [ *](\S+)\s*$/.exec(text.split(/\r?\n/)[0] ?? '');
  if (!match || match[2] !== name) {
    throw failure(`The published checksum of the ${label.what} for v${label.version} is not readable.`, 'download_failed');
  }
  return match[1];
}

async function download(url, path, label, fetchImpl) {
  const response = await fetchRelease(url, label, fetchImpl, DOWNLOAD_TIMEOUT_MS);
  let received = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), async function* limit(source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > MAX_ASSET_BYTES) {
          throw failure(`The ${label.what} for v${label.version} is larger than expected; nothing was installed.`, 'download_failed');
        }
        yield chunk;
      }
    }, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    if (error?.code === 'download_failed') throw error;
    throw failure(`The ${label.what} for v${label.version} could not be downloaded (${error?.message ?? error}).`, 'download_failed');
  }
}
