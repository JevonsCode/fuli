import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { packageDigest } from '../employees/install-package.js';
import { packageFile } from '../employees/manifest.js';
import { invalidAppInput } from './errors.js';

export const MAX_APP_FILES = 128;
const MAX_APP_PACKAGE_BYTES = 1024 * 1024;
// Base64 of the whole byte budget, so an oversized file fails on its size.
export const MAX_APP_FILE_CONTENT_LENGTH = Math.ceil(MAX_APP_PACKAGE_BYTES / 3) * 4 + 4;
// The manifest is stored beside the files it describes, like employee.json.
const MANIFEST_FILE = 'app.json';
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// Windows treats these names as devices in every directory, with any extension.
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const appFilePath = packageFile
  .refine((path) => path.split('/').every((segment) =>
    SEGMENT.test(segment) && !segment.endsWith('.') && !DEVICE_NAME.test(segment)),
  'Use visible names made of letters, digits, ".", "-" and "_"; no device names')
  .refine((path) => path !== MANIFEST_FILE, `${MANIFEST_FILE} is reserved for the manifest`);

// A file is plain content only: no mode, link target or other entry type exists.
const submittedFiles = z.array(z.object({
  path: appFilePath,
  content: z.string().max(MAX_APP_FILE_CONTENT_LENGTH),
  encoding: z.enum(['utf8', 'base64']).default('utf8')
}).strict()).min(1).max(MAX_APP_FILES);

export function parsePackageFiles(value, manifest) {
  const parsed = submittedFiles.safeParse(value);
  if (!parsed.success) throw invalidAppInput('invalid_package', 'Invalid app files', parsed.error.issues);
  const files = parsed.data.map(({ path, content, encoding }) => {
    if (encoding === 'base64' && !BASE64.test(content)) throw invalidPackage(`${path} is not valid base64`);
    return { path, data: Buffer.from(content, encoding) };
  }).sort((left, right) => (left.path < right.path ? -1 : 1));
  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  if (bytes > MAX_APP_PACKAGE_BYTES) {
    throw new ApplicationError('package_too_large', `An app version holds at most ${MAX_APP_PACKAGE_BYTES} bytes`, { status: 413 });
  }
  assertDistinctPaths(files);
  assertRuntimeFiles(manifest.runtime, new Set(files.map(({ path }) => path)));
  return { files, bytes };
}

// Writes a version into a private staging directory beside its final place and
// returns the digest of what is on disk, so the digest covers exactly the files
// that will run. The caller commits or discards it.
export function stagePackage(appPackages, manifest, files) {
  mkdirSync(appPackages, { recursive: true, mode: 0o700 });
  if (lstatSync(appPackages).isSymbolicLink()) throw invalidPackage('The app package directory is a link');
  const staging = mkdtempSync(join(appPackages, '.staging-'));
  try {
    writeFileSync(join(staging, MANIFEST_FILE), canonicalJson(manifest), { flag: 'wx' });
    for (const { path, data } of files) {
      const target = join(staging, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { flag: 'wx' });
    }
    return { staging, digest: packageDigest(staging, { receipt: null }) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error instanceof TypeError ? invalidPackage(error.message) : error;
  }
}

// A directory already at the target has no registry row: an interrupted write.
export function commitPackage(staging, target) {
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}

export function discardPackage(staging) {
  rmSync(staging, { recursive: true, force: true });
}

// True only while the stored files are exactly the package with this digest.
export function storedPackageMatches(directory, digest) {
  try {
    return packageDigest(directory, { receipt: null }) === digest;
  } catch {
    return false;
  }
}

export function removePackages(appPackages) {
  rmSync(appPackages, { recursive: true, force: true });
}

function assertDistinctPaths(files) {
  // Windows and macOS file systems ignore case, so names must differ beyond it.
  const names = new Set();
  for (const { path } of files) {
    const name = path.toLowerCase();
    if (names.has(name)) throw invalidPackage(`${path} differs from another file only by case`);
    names.add(name);
  }
  for (const { path } of files) {
    const parts = path.toLowerCase().split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (names.has(parts.slice(0, depth).join('/'))) throw invalidPackage(`${path} is inside a path that is a file`);
    }
  }
}

function assertRuntimeFiles({ entry, webRoot }, paths) {
  if (entry && !paths.has(entry)) throw invalidPackage(`runtime.entry ${entry} is not among the files`);
  if (webRoot && !paths.has(`${webRoot}/index.html`)) throw invalidPackage(`runtime.webRoot needs ${webRoot}/index.html`);
}

function invalidPackage(message) {
  return invalidAppInput('invalid_package', 'Invalid app package', [{ path: [], message }]);
}
