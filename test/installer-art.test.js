import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SETUP_PICTURES, SETUP_SCALES, installerArt } from '../scripts/build-installer-art.js';
import { SETUP_SCRIPT } from '../scripts/build-windows-setup.js';
import { DMG_BACKGROUND, DMG_ICONS, DMG_WINDOW, dmgSettings } from '../scripts/package-macos-dmg.js';

// The installers' pictures are drawn by scripts/build-installer-art.js and
// committed; these checks keep them, the .dmg layout and FULI-Setup in step.

const root = fileURLToPath(new URL('../', import.meta.url));
const script = readFileSync(SETUP_SCRIPT, 'utf8');

function pngSize(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR', path + ' is a PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('every installer picture exists at its size', () => {
  const outputs = installerArt().flatMap(rendering => rendering.outputs);
  assert.ok(outputs.length > 30);
  for (const [output, width, height] of outputs) {
    assert.ok(existsSync(join(root, output)), output + ' exists; run node scripts/build-installer-art.js');
    assert.deepEqual(pngSize(join(root, output)), [width, height], output);
  }
});

test('the .dmg window matches its background and places both icons on it', () => {
  assert.deepEqual(pngSize(DMG_BACKGROUND), [DMG_WINDOW.width, DMG_WINDOW.height]);
  assert.deepEqual(pngSize(DMG_BACKGROUND.replace(/\.png$/, '@2x.png')), [DMG_WINDOW.width * 2, DMG_WINDOW.height * 2]);
  const settings = dmgSettings({ app: '/tmp/FULI.app' });
  assert.equal(settings.title, 'FULI');
  assert.equal(settings.background, DMG_BACKGROUND);
  assert.deepEqual(settings.window.size, DMG_WINDOW);
  assert.equal(settings.icon, undefined, 'no volume icon unless the app has one');
  assert.deepEqual(settings.contents, [
    // Never hide_extension: it marks FULI.app with Finder info and breaks its signature.
    { ...DMG_ICONS.app, type: 'file', path: '/tmp/FULI.app' },
    { ...DMG_ICONS.applications, type: 'link', path: '/Applications' },
  ]);
  for (const { x, y } of Object.values(DMG_ICONS)) {
    assert.ok(x > 0 && x < DMG_WINDOW.width && y > 0 && y < DMG_WINDOW.height);
  }
  assert.equal(dmgSettings({ app: '/tmp/FULI.app', volumeIcon: '/tmp/AppIcon.icns' }).icon, '/tmp/AppIcon.icns');
  // The background's arrow runs between the two places the layout uses.
  const page = readFileSync(join(root, 'desktop', 'installer-art', 'dmg-background.html'), 'utf8');
  assert.match(page, new RegExp(`FULI\\.app at ${DMG_ICONS.app.x},${DMG_ICONS.app.y} and Applications at ${DMG_ICONS.applications.x},${DMG_ICONS.applications.y}`));
});

test('FULI-Setup uses a wizard picture for every DPI and extracts its page pictures', () => {
  const list = name => new RegExp(`^${name}=(.+)$`, 'm').exec(script)[1].split(',');
  assert.deepEqual(list('WizardImageFile'), SETUP_SCALES.map(({ percent }) => `art\\panel-${percent}.png`));
  assert.deepEqual(list('WizardSmallImageFile'), SETUP_SCALES.map(({ percent }) => `art\\small-${percent}.png`));
  for (const name of Object.keys(SETUP_PICTURES)) {
    assert.match(script, new RegExp(`^Source: "art\\\\${name}-\\*\\.png"; DestDir: "\\{tmp\\}"; Flags: dontcopy$`, 'm'));
    assert.match(script, new RegExp(`PagePicture\\([^;]+'${name}'`), name + ' is shown on a page');
  }
  // The scales PictureScale chooses are the drawn ones.
  const pick = script.slice(script.indexOf('function PictureScale'), script.indexOf('function PagePicture'));
  const chosen = [...pick.matchAll(/Result := (\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(chosen, SETUP_SCALES.map(({ percent }) => percent));
  assert.match(script, new RegExp(`^#define PictureSize ${SETUP_PICTURES.icon}$`, 'm'));
  assert.equal(SETUP_PICTURES.done, SETUP_PICTURES.icon);
  assert.match(script, new RegExp(`^#define MarkSize ${SETUP_PICTURES.mark}$`, 'm'));
});
