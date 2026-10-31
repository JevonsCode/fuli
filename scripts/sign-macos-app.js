import { open, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isMainModule } from '../src/system/main-module.js';
import { PACKAGE_ROOT, progress, run } from './bundle-build.js';

// Signs FULI.app inside out: every Mach-O file of the bundled runtime
// (Contents/Resources/fuli), Flutter's frameworks, then the app. Adding the
// runtime to the client's bundle breaks the signature `flutter build macos`
// made, so every build signs again.
//
// identity '-' (the default) is an ad-hoc signature: what unsigned CI builds
// use, enough for Apple silicon to run the code, still subject to Gatekeeper's
// "Open Anyway". A Developer ID identity adds the hardened runtime and a
// secure timestamp, which notarization requires; each runtime executable then
// gets only the entitlements its desktop/macos/*.entitlements file explains.

const CODESIGN = '/usr/bin/codesign';
const APP_ENTITLEMENTS = join(PACKAGE_ROOT, 'desktop', 'flutter', 'macos', 'Runner', 'Release.entitlements');
const RUNTIME_ENTITLEMENTS = [
  [/^runtime\/node\/bin\/node$/, 'node.entitlements'],
  [/^runtime\/jre21\/(bin\/[^/]+|lib\/jspawnhelper)$/, 'java.entitlements'],
  [/^runtime\/python\/bin\/python3[.\d]*$/, 'python.entitlements']
];
// Mach-O magic numbers as read big-endian from the first four bytes.
const THIN = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);
const FAT = 0xcafebabe;
// A Java class file starts with the same 0xcafebabe; its next word is a class
// file version (45 and up), a fat header's is its architecture count.
const MAX_FAT_ARCHITECTURES = 20;
// What codesign signs: executables, dynamic libraries and loadable bundles, not object files.
const SIGNED_FILE_TYPES = new Set([2, 6, 8]);

export function runtimeEntitlements(relativePath) {
  const match = RUNTIME_ENTITLEMENTS.find(([pattern]) => pattern.test(relativePath));
  return match ? join(PACKAGE_ROOT, 'desktop', 'macos', match[1]) : null;
}

async function signableMachO(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, 16, 0);
    if (bytesRead < 16) return false;
    const magic = header.readUInt32BE(0);
    if (magic === FAT) return header.readUInt32BE(4) > 0 && header.readUInt32BE(4) <= MAX_FAT_ARCHITECTURES;
    if (!THIN.has(magic)) return false;
    const fileType = magic === 0xcffaedfe || magic === 0xcefaedfe ? header.readUInt32LE(12) : header.readUInt32BE(12);
    return SIGNED_FILE_TYPES.has(fileType);
  } finally {
    await file.close();
  }
}

// Regular files only: a symbolic link (python3 -> python3.12) is signed through its target.
async function machOFiles(root, directory = root) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await machOFiles(root, path));
    else if (entry.isFile() && await signableMachO(path)) found.push(relative(root, path).split(sep).join('/'));
  }
  return found;
}

export async function signMacosApp({ app, identity = '-', keychain = null } = {}) {
  if (process.platform !== 'darwin') throw new Error('Sign the macOS app on macOS.');
  if (typeof app !== 'string' || !isAbsolute(app) || !existsSync(join(app, 'Contents', 'Info.plist'))) {
    throw new Error('Expected an absolute --app path to FULI.app.');
  }
  const base = ['--force', '--sign', identity,
    ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']),
    ...(keychain ? ['--keychain', keychain] : [])];
  const sign = (path, entitlements) => run(CODESIGN, [...base,
    ...(entitlements ? ['--entitlements', entitlements] : []), path], { capture: true });
  const root = join(app, 'Contents', 'Resources', 'fuli');
  // Deepest first, so a library is signed before anything that contains it.
  const files = (await machOFiles(root)).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  progress('Signing ' + files.length + ' runtime executables and libraries' + (identity === '-' ? ' (ad hoc)' : ''));
  for (const file of files) await sign(join(root, file), identity === '-' ? null : runtimeEntitlements(file));
  const frameworks = join(app, 'Contents', 'Frameworks');
  if (existsSync(frameworks)) {
    for (const name of (await readdir(frameworks)).sort()) await sign(join(frameworks, name), null);
  }
  await sign(app, APP_ENTITLEMENTS);
  await run(CODESIGN, ['--verify', '--deep', '--strict', app], { capture: true });
  return { app, files: files.length, identity: identity === '-' ? 'ad-hoc' : 'developer-id' };
}

if (isMainModule(import.meta.url)) {
  const names = { '--app': 'app', '--identity': 'identity', '--keychain': 'keychain' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid signing option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    const result = await signMacosApp(options);
    progress('Signed ' + result.app + ' (' + result.identity + ', ' + result.files + ' runtime files)');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
