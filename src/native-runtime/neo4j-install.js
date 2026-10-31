import { execFile } from 'node:child_process';
import { access, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { sha256File } from '../security/digest.js';
import { downloadResumable } from './resumable-download.js';

// Immutable, versioned assets only. Instance data lives outside this directory.
// bundledArchive: the same pinned archive shipped with the macOS app
// (macos-assets.js), copied instead of downloaded and verified the same way.
export async function installNativeNeo4j({ paths, home, url, sha256, bundledArchive = null }, {
  download = downloadFile, extract = extractArchive
} = {}) {
  let root = resolve(paths.nativeRuntimeDir);
  if (dirname(resolve(home)) !== root || !/^neo4j-community-\d+\.\d+\.\d+$/.test(basename(home))) {
    throw new Error('Neo4j destination must be a version directory in the managed runtime.');
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid Neo4j checksum.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error('Managed Neo4j runtime must not be a symbolic link.');
  root = await realpath(root);
  home = join(root, basename(home));
  const lock = join(root, '.neo4j-install.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Neo4j installation lock exists; another installation may be in progress.'); throw error; }
  let stage;
  try {
    try {
      await lstat(home);
      // Never delete or repair a possibly active or user-modified installation.
      throw new Error('An existing Neo4j directory was preserved. Inspect the incomplete installation before retrying.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const downloads = join(root, 'downloads');
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    if (!(await lstat(downloads)).isDirectory()) throw new Error('Neo4j download directory must not be a symbolic link.');
    const archive = join(downloads, `${basename(home)}-unix.tar.gz`);
    let cached = false;
    try { cached = (await lstat(archive)).isFile() && await sha256File(archive) === sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!cached) await (bundledArchive ? copyFile(bundledArchive, archive) : download(url, archive));
    if (await sha256File(archive) !== sha256) throw new Error('The downloaded Neo4j archive failed checksum verification.');
    stage = await mkdtemp(join(root, '.neo4j-stage-'));
    const unpacked = join(stage, 'unpacked');
    await mkdir(unpacked);
    await extract(archive, unpacked);
    const candidate = join(unpacked, basename(home));
    for (const name of ['bin/neo4j', 'bin/neo4j-admin']) {
      const path = join(candidate, name);
      if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error('Neo4j archive contains an invalid executable.');
      await access(path, constants.X_OK);
    }
    // Same-filesystem rename is the only publication operation. No partial home.
    await rename(candidate, home);
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true }); }
  }
}

async function extractArchive(archive, destination) {
  await new Promise((resolveRun, reject) => execFile('tar', ['-xzf', archive, '-C', destination], {
    timeout: 600_000, maxBuffer: 4 * 1024 * 1024
  }, error => error ? reject(new Error('Neo4j archive extraction failed.', { cause: error })) : resolveRun()));
}

function downloadFile(url, destination) {
  return downloadResumable(url, destination, { what: 'Neo4j' });
}
