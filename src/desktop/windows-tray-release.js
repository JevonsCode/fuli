import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { downloadVerifiedReleaseAsset, releaseChecksumLine } from './release-asset.js';
import { trayInventory } from './windows-installation.js';

// What a GitHub release publishes for the per-user Windows (tray) install:
// the tray candidate as one zip with its SHA-256 beside it
// (.github/workflows/release.yml runs scripts/package-windows-tray-release.js).

export const trayArchiveName = version => `fuli-windows-tray-${version}.zip`;
export const trayChecksumLine = releaseChecksumLine;

// Downloads one release's tray candidate into directory (new and empty) and
// returns the extracted package directory once the archive matches its
// published digest, every file matches the candidate's own inventory, and the
// candidate is the version asked for. progress(step) names the real step.
export async function downloadWindowsTrayRelease(version, directory, {
  fetchImpl = globalThis.fetch, extract = extractZip, progress = () => {}
} = {}) {
  const archive = await downloadVerifiedReleaseAsset({ version, name: trayArchiveName(version), directory,
    what: 'Windows package' }, { fetchImpl, progress });
  const source = join(directory, 'package');
  mkdirSync(source);
  await extract(archive, source);
  const packaged = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  if (packaged !== version) throw new Error(`The Windows package for v${version} contains v${packaged}; nothing was installed.`);
  trayInventory(source);
  return source;
}

// Windows' own tar reads zip archives and refuses absolute or parent paths.
function extractZip(archive, target) {
  return new Promise((resolve, reject) => {
    execFile(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', target],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
      error => error ? reject(new Error('The Windows package could not be unpacked; nothing was installed.')) : resolve());
  });
}
