import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../src/system/main-module.js';
import { decodePng, encodePng } from './brand/png.js';
import { resizeArea } from './brand/raster.js';
import { DMG_WINDOW as DMG } from './package-macos-dmg.js';

// The installers' pictures: desktop/installer-art/*.html (drawn from brand/ and
// the DESIGN.md colours) rendered by headless Chrome into the PNG files the
// .dmg window, FULI-Setup and the install docs show. Run it after changing a
// page there or the brand, and commit the pictures with their pages:
//
//   node scripts/build-installer-art.js [--chrome <path to Chrome or Edge>]
//
// Headless Chrome keeps a minimum window width, so small pictures are rendered
// large once and scaled down here. test/installer-art.test.js checks every
// picture's size.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'desktop', 'installer-art');

// Inno Setup's image areas per DPI (modern wizard, 6.6 and later).
export const SETUP_SCALES = [
  { percent: 100, panel: [202, 386], small: 58 },
  { percent: 125, panel: [269, 515], small: 77 },
  { percent: 150, panel: [336, 643], small: 97 },
  { percent: 175, panel: [403, 772], small: 116 },
  { percent: 200, panel: [430, 824], small: 124 },
  { percent: 225, panel: [498, 953], small: 143 },
  { percent: 250, panel: [534, 1022], small: 159 },
];
// The page pictures FULI-Setup's [Code] places, with their size in points at
// 100 % (fuli-setup.iss #define PictureSize and MarkSize).
export const SETUP_PICTURES = { icon: 120, done: 120, mark: 80 };
// The .dmg window in points (scripts/package-macos-dmg.js lays the icons out on it).
const DMG_WINDOW = [DMG.width, DMG.height];

const SETUP_ART = 'desktop/windows-setup/art';

// Each rendering: a page (with its #view) at a CSS size and device scale, and
// the pictures cut from it: [output path, width, height] (scaled when smaller).
export function installerArt() {
  const scaled = (name, size) => SETUP_SCALES.map(scale => [`${SETUP_ART}/${name}-${scale.percent}.png`, ...size(scale)]);
  return [
    { page: 'dmg-background.html', size: DMG_WINDOW, scale: 1, outputs: [['desktop/macos-dmg/background.png', ...DMG_WINDOW]] },
    { page: 'dmg-background.html', size: DMG_WINDOW, scale: 2,
      outputs: [['desktop/macos-dmg/background@2x.png', DMG_WINDOW[0] * 2, DMG_WINDOW[1] * 2]] },
    { page: 'dmg-background.html#steps', size: [612, 128], scale: 2, outputs: [['docs/images/install/macos-first-open.png', 1224, 256]] },
    { page: 'windows-smartscreen.html', size: [612, 200], scale: 2, outputs: [['docs/images/install/windows-smartscreen.png', 1224, 400]] },
    { page: 'wizard-panel.html', size: [1010, 1930], scale: 1, outputs: scaled('panel', scale => scale.panel) },
    { page: 'app-icon.html#small', size: [960, 960], scale: 1, outputs: scaled('small', scale => [scale.small, scale.small]) },
    ...Object.entries(SETUP_PICTURES).map(([name, points]) => ({ page: `app-icon.html#${name}`, size: [960, 960], scale: 1,
      outputs: scaled(name, scale => Array(2).fill(Math.round(points * scale.percent / 100))) })),
  ];
}

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function screenshot(chrome, profile, { page, size: [width, height], scale }, file) {
  const [name, view = ''] = page.split('#');
  const url = pathToFileURL(join(ART, name)).href + (view ? '#' + view : '');
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--default-background-color=00000000', `--user-data-dir=${profile}`, `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`, '--virtual-time-budget=4000', `--screenshot=${file}`, url];
  return new Promise((done, reject) => execFile(chrome, args, { timeout: 60_000 },
    error => error ? reject(new Error(`Rendering ${page} failed: ${error.message}`)) : done()));
}

export async function buildInstallerArt({ chrome = CHROME_PATHS.find(path => existsSync(path)) } = {}) {
  if (!chrome || !existsSync(chrome)) throw new Error('Chrome or Edge is required: pass --chrome <path>.');
  const work = await mkdtemp(join(tmpdir(), 'fuli-installer-art-'));
  const written = [];
  try {
    for (const [index, rendering] of installerArt().entries()) {
      const shot = join(work, `${index}.png`);
      await screenshot(chrome, join(work, 'profile'), rendering, shot);
      const image = decodePng(await readFile(shot));
      const [expectedWidth, expectedHeight] = rendering.size.map(side => side * rendering.scale);
      if (image.width !== expectedWidth || image.height !== expectedHeight) {
        throw new Error(`${rendering.page} rendered at ${image.width}x${image.height}, not ${expectedWidth}x${expectedHeight}.`);
      }
      for (const [output, width, height] of rendering.outputs) {
        const picture = image.width === width && image.height === height ? image : resizeArea(image, width, height);
        await mkdir(dirname(join(ROOT, output)), { recursive: true });
        await writeFile(join(ROOT, output), encodePng(picture));
        written.push(output);
      }
    }
    return written;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const at = process.argv.indexOf('--chrome');
  try {
    for (const output of await buildInstallerArt(at > 0 ? { chrome: process.argv[at + 1] } : {})) {
      process.stdout.write(output + '\n');
    }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
