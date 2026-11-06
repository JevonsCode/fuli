import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macosDmgName } from '../src/desktop/macos-app-update.js';
import { readMacosNativeBundle } from '../src/native-runtime/macos-assets.js';
import { isMainModule } from '../src/system/main-module.js';
import { progress, run } from './bundle-build.js';

// The disk image people download: a window with FULI.app, an arrow and a link
// to Applications to drag it onto, and below them the pictures of an unsigned
// build's first open (desktop/macos-dmg/background.png and @2x, drawn by
// scripts/build-installer-art.js). dmgbuild (a maintained Python tool, pinned
// in .github/actions/macos-app) writes the window layout into .DS_Store
// without driving Finder and copies FULI.app with ditto. Built from a signed
// FULI.app (scripts/sign-macos-app.js); a Developer ID build signs and
// notarizes the image afterwards.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DMG_BACKGROUND = join(ROOT, 'desktop', 'macos-dmg', 'background.png');
// The background's size in points (build-installer-art.js DMG_WINDOW) and
// where its arrow points: FULI.app on the left, Applications on the right.
export const DMG_WINDOW = { width: 660, height: 440 };
export const DMG_ICONS = { app: { x: 170, y: 150 }, applications: { x: 490, y: 150 } };

// dmgbuild's JSON settings for this image.
export function dmgSettings({ app, background = DMG_BACKGROUND, volumeIcon = null }) {
  return {
    title: 'FULI',
    ...(volumeIcon ? { icon: volumeIcon } : {}),
    background,
    'icon-size': 112,
    'text-size': 13,
    window: { position: { x: 200, y: 120 }, size: DMG_WINDOW },
    format: 'UDZO',
    filesystem: 'HFS+',
    contents: [
      { ...DMG_ICONS.app, type: 'file', path: app, hide_extension: true },
      { ...DMG_ICONS.applications, type: 'link', path: '/Applications' },
    ],
  };
}

export async function packageMacosDmg({ app, output, dmgbuild = 'dmgbuild' } = {}) {
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
  const icon = join(app, 'Contents', 'Resources', 'AppIcon.icns');
  const stage = await mkdtemp(join(tmpdir(), 'fuli-dmg-'));
  try {
    const settings = join(stage, 'dmg.json');
    await writeFile(settings, JSON.stringify(dmgSettings({ app, volumeIcon: existsSync(icon) ? icon : null }), null, 2));
    progress('Creating ' + dmg);
    await run(dmgbuild, ['-s', settings, 'FULI', dmg], { capture: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { dmg, version };
}

if (isMainModule(import.meta.url)) {
  const names = { '--app': 'app', '--output': 'output', '--dmgbuild': 'dmgbuild' };
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
