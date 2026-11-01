#!/usr/bin/env node
// Generates every copy of the FULI brand from brand/ (brand/README.md): the
// console's and the site's marks, wordmarks, favicon and motion stylesheet, the
// mark's data for clients that draw it, and the desktop client's tray, Windows
// and macOS icons. Run `node scripts/build-brand-assets.js` after changing a file
// there; test/brand-assets.test.js fails while a copy is stale.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../src/system/main-module.js';
import { marginedIcon, trayIcon } from './brand/icon-art.js';
import { decodeIco, encodeIco } from './brand/ico.js';
import { sameBytes, samePixels } from './brand/image-content.js';
import { markContract, markDrawing } from './brand/mark-contract.js';
import { readMarkSvg } from './brand/mark-svg.js';
import { decodePng, encodePng } from './brand/png.js';
import { readWordmarkSvg, wordmarkContract } from './brand/wordmark-svg.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKS = {
  master: 'brand/svg/mark/fuli-mark-color.svg',
  masterDark: 'brand/svg/mark/fuli-mark-dark.svg',
  micro: 'brand/svg/mark/fuli-mark-micro-color.svg',
  microDark: 'brand/svg/mark/fuli-mark-micro-dark.svg'
};
const WORDMARKS = { zh: 'brand/svg/wordmark/fuli-wordmark-zh.svg', en: 'brand/svg/wordmark/fuli-wordmark-en.svg' };
const APP_ICO = 'brand/png/app-icon/fuli-app.ico';
// The ready app icons above the ICO's largest entry.
const APP_ICON_PNGS = ['brand/png/app-icon/fuli-app-icon-light-512.png', 'brand/png/app-icon/fuli-app-icon-light-1024.png'];
// Files shipped as they are, at the paths the console, the site and the desktop client load.
const COPIES = {
  'brand/svg/mark/fuli-mark-color.svg': ['web/assets/brand/fuli-mark-color.svg', 'site/assets/brand/fuli-mark-color.svg'],
  'brand/svg/mark/fuli-mark-dark.svg': ['site/assets/brand/fuli-mark-dark.svg'],
  'brand/svg/wordmark/fuli-wordmark-en.svg': ['web/assets/brand/fuli-wordmark-en.svg'],
  'brand/svg/wordmark/fuli-wordmark-zh.svg': ['web/assets/brand/fuli-wordmark-zh.svg'],
  'brand/motion/fuli-motion.css': ['web/assets/brand/fuli-motion.css'],
  'brand/png/mark/favicon.ico': ['web/public/favicon.ico', 'site/assets/brand/favicon.ico'],
  // The site's link preview image.
  'brand/png/mark/fuli-mark-color-512.png': ['site/assets/brand/fuli-mark-color-512.png'],
  // The client's and the Fuli.exe launcher's icon (scripts/build-windows-tray.js).
  [APP_ICO]: ['desktop/flutter/windows/runner/resources/app_icon.ico']
};
// The mark as data: the desktop client's contract and the console's drawing data.
const MARK_CONTRACT = 'desktop/flutter/assets/brand/fuli-mark.json';
// The wordmarks as data, for the desktop client's top line.
const WORDMARK_CONTRACT = 'desktop/flutter/assets/brand/fuli-wordmark.json';
const MARK_DRAWING = 'web/assets/brand/fuli-mark.json';
// The optical sizing rule: the micro cut below 28 px, the master cut from 28 px.
const MICRO_BELOW_PX = 28;
const DESKTOP = 'desktop/flutter';
const STATUS_DOTS = { ok: 0x1f9a76, needs_person: 0xd08a1e, broken: 0xc0453a };
// macOS shows the menu bar icon at 18 pt; 36 px keeps it sharp on Retina.
const TRAY_PNG_SIZE = 36;
// Windows draws tray icons at 16 px on 100 % scaling, up to 32 px at 200 %.
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48];
const NOTIFICATION_ICON_SIZE = 256;
const MACOS_APP_ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const MACOS_APP_ICON_MARGIN = 0.1;

const readProjectFile = (path) => readFileSync(join(PROJECT_ROOT, path));

// Every derived file as { path, bytes, same }, [same] telling whether a file on disk
// still matches; [read] gives a brand/ file's bytes by its project path.
export function brandAssets(read = readProjectFile) {
  const marks = Object.fromEntries(Object.entries(MARKS).map(([cut, path]) => [cut, readMarkSvg(read(path).toString('utf8'))]));
  const contract = markContract(marks);
  const wordmarks = Object.fromEntries(Object.entries(WORDMARKS).map(([language, path]) => [language, readWordmarkSvg(read(path).toString('utf8'))]));
  const markFor = (pixels) => (pixels < MICRO_BELOW_PX ? marks.micro : marks.master);
  const json = (data) => Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  const appIcons = [
    ...decodeIco(read(APP_ICO)).map(({ size, bytes }) => ({ size, bytes })),
    ...APP_ICON_PNGS.map((path) => ({ size: decodePng(read(path)).width, bytes: read(path) }))
  ].sort((a, b) => a.size - b.size);
  // The smallest ready app icon at least [size] wide: the brand's own optical cut for that size.
  const appIconFor = (size) => decodePng((appIcons.find((icon) => icon.size >= size) ?? appIcons.at(-1)).bytes);
  const copies = [
    ...Object.entries(COPIES).flatMap(([source, paths]) => paths.map((path) => ({ path, bytes: read(source) }))),
    { path: MARK_CONTRACT, bytes: json(contract) },
    { path: WORDMARK_CONTRACT, bytes: json(wordmarkContract(wordmarks, contract.ink)) },
    { path: MARK_DRAWING, bytes: json(markDrawing(marks, MICRO_BELOW_PX)) }
  ].map((asset) => ({ ...asset, same: sameBytes }));
  const ico = (draw, sizes) => encodeIco(sizes.map((size) => ({ size, bytes: encodePng(draw(size)) })));
  const drawn = [
    ...Object.entries(STATUS_DOTS).flatMap(([status, dot]) => [
      { path: `${DESKTOP}/assets/tray/${status}.png`, bytes: encodePng(trayIcon(markFor, TRAY_PNG_SIZE, dot)) },
      { path: `${DESKTOP}/assets/tray/${status}.ico`, bytes: ico((size) => trayIcon(markFor, size, dot), TRAY_ICO_SIZES) }
    ]),
    // Windows notifications.
    { path: `${DESKTOP}/assets/app/fuli.png`, bytes: encodePng(appIconFor(NOTIFICATION_ICON_SIZE)) },
    ...MACOS_APP_ICON_SIZES.map((size) => ({
      path: `${DESKTOP}/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_${size}.png`,
      bytes: encodePng(marginedIcon(appIconFor(size), size, MACOS_APP_ICON_MARGIN))
    }))
  ].map((asset) => ({ ...asset, same: samePixels }));
  return [...copies, ...drawn];
}

// Writes the assets under [outputRoot], leaving files that already match; returns the written paths.
export function writeBrandAssets(outputRoot, assets = brandAssets()) {
  const written = [];
  for (const { path, bytes, same } of assets) {
    const target = join(outputRoot, path);
    if (existsSync(target) && same(readFileSync(target), bytes)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    written.push(path);
  }
  return written;
}

if (isMainModule(import.meta.url)) {
  const written = writeBrandAssets(PROJECT_ROOT);
  console.log(written.length ? written.map((path) => `wrote ${path}`).join('\n') : 'brand assets are up to date');
}
