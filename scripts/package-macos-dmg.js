import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readMacosNativeBundle } from '../src/native-runtime/macos-assets.js';
import { isMainModule } from '../src/system/main-module.js';
import { progress, run } from './bundle-build.js';

// The disk image people download: FULI.app beside a link to /Applications, to
// drag it across. Built from a signed FULI.app (scripts/sign-macos-app.js); a
// Developer ID build signs and notarizes the image afterwards.
const macosDmgName = (version, arch) => `fuli-macos-${arch}-${version}.dmg`;

export async function packageMacosDmg({ app, output } = {}) {
  if (process.platform !== 'darwin') throw new Error('Package the macOS app on macOS.');
  for (const [name, path] of Object.entries({ app, output })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  const root = join(app, 'Contents', 'Resources', 'fuli');
  const bundle = readMacosNativeBundle(root);
  if (!bundle) throw new Error('FULI.app has no bundled runtime; build it with scripts/build-macos-app.js.');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const dmg = join(output, macosDmgName(version, bundle.arch));
  if (existsSync(dmg)) throw new Error('The disk image already exists: ' + dmg);
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), 'fuli-dmg-'));
  try {
    await run('/usr/bin/ditto', [app, join(stage, 'FULI.app')]);
    await symlink('/Applications', join(stage, 'Applications'));
    progress('Creating ' + dmg);
    await run('/usr/bin/hdiutil', ['create', '-volname', 'FULI', '-srcfolder', stage, '-fs', 'HFS+',
      '-format', 'UDZO', dmg], { capture: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { dmg, version };
}

if (isMainModule(import.meta.url)) {
  const names = { '--app': 'app', '--output': 'output' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    progress('Packaged ' + (await packageMacosDmg(options)).dmg);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
