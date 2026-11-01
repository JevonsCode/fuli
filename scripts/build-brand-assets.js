#!/usr/bin/env node
// Generates every copy of the FULI logo from brand/fuli-logo.png: the console's
// and the site's copies, and the desktop client's tray, notification, Windows
// and macOS icons. Run `node scripts/build-brand-assets.js` after replacing the
// logo; test/brand-assets.test.js fails while a copy is stale.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../src/system/main-module.js';
import { appIcon, trayIcon } from './brand/icon-art.js';
import { encodeIco } from './brand/ico.js';
import { sameBytes, samePixels } from './brand/image-content.js';
import { decodePng, encodePng } from './brand/png.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(PROJECT_ROOT, 'brand/fuli-logo.png');
// Paths the console, the site, README images and the published site already load.
const LOGO_COPIES = ['web/assets/brand/fuli-logo.png', 'site/assets/fuli-logo.png', 'site/v0/assets/fuli-logo.png'];
const DESKTOP = 'desktop/flutter';
const STATUS_DOTS = { ok: 0x1f9a76, needs_person: 0xd08a1e, broken: 0xc0453a };
// macOS shows the menu bar icon at 18 pt; 36 px keeps it sharp on Retina.
const TRAY_PNG_SIZE = 36;
// Windows draws tray icons at 16 px on 100 % scaling, up to 32 px at 200 %.
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48];
const NOTIFICATION_ICON_SIZE = 256;
const WINDOWS_APP_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const MACOS_APP_ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const MACOS_APP_ICON_MARGIN = 0.1;

const ico = (draw, sizes) => encodeIco(sizes.map((size) => ({ size, bytes: encodePng(draw(size)) })));

// Every derived file as { path, bytes, same }, [same] telling whether a file on disk still matches.
export function brandAssets(sourceBytes = readFileSync(SOURCE)) {
  const logo = decodePng(sourceBytes);
  const copies = LOGO_COPIES.map((path) => ({ path, bytes: sourceBytes, same: sameBytes }));
  const drawn = [
    ...Object.entries(STATUS_DOTS).flatMap(([status, dot]) => [
      { path: `${DESKTOP}/assets/tray/${status}.png`, bytes: encodePng(trayIcon(logo, TRAY_PNG_SIZE, dot)) },
      { path: `${DESKTOP}/assets/tray/${status}.ico`, bytes: ico((size) => trayIcon(logo, size, dot), TRAY_ICO_SIZES) }
    ]),
    // Windows notifications.
    { path: `${DESKTOP}/assets/app/fuli.png`, bytes: encodePng(appIcon(logo, NOTIFICATION_ICON_SIZE)) },
    // The client's and the Fuli.exe launcher's icon (scripts/build-windows-tray.js).
    { path: `${DESKTOP}/windows/runner/resources/app_icon.ico`, bytes: ico((size) => appIcon(logo, size), WINDOWS_APP_ICO_SIZES) },
    ...MACOS_APP_ICON_SIZES.map((size) => ({
      path: `${DESKTOP}/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_${size}.png`,
      bytes: encodePng(appIcon(logo, size, { margin: MACOS_APP_ICON_MARGIN }))
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
