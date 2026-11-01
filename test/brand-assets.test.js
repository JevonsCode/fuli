import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { brandAssets, PROJECT_ROOT, writeBrandAssets } from '../scripts/build-brand-assets.js';
import { encodeIco, decodeIco } from '../scripts/brand/ico.js';
import { trayIcon } from '../scripts/brand/icon-art.js';
import { readMarkSvg } from '../scripts/brand/mark-svg.js';
import { decodePng, encodePng } from '../scripts/brand/png.js';

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-brand-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const brandFile = (path) => readFileSync(join(PROJECT_ROOT, path));

// A synthetic mark: the six layers as plain shapes, using every path command the reader draws.
function syntheticMark({ fill, stops, barTop = 120 }) {
  const stopTags = stops.map(([offset, color]) => `<stop offset="${offset}%" stop-color="${color}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="gold" x1="0" y1="300" x2="300" y2="500" gradientUnits="userSpaceOnUse">${stopTags}</linearGradient></defs>
  <path class="fuli-orbit-gold" fill="url(#gold)" d="M 40 300 A 220 220 0 0 0 470 300 L 440 300 A 190 190 0 0 1 70 300 Z"/>
  <path class="fuli-orbit-upper" fill="${fill}" d="M 40 250 A 220 220 0 0 1 300 40 L 300 70 A 190 190 0 0 0 70 250 Z"/>
  <path class="fuli-wave" fill="${fill}" d="M 60 260 C 150 200, 250 360, 470 240 L 470 280 Q 250 400, 60 300 Z"/>
  <path class="fuli-bar fuli-bar--1" fill="${fill}" d="M 290 220 L 330 220 L 330 320 L 290 320 Z"/>
  <path class="fuli-bar fuli-bar--2" fill="${fill}" d="M 350 170 L 390 170 L 390 330 L 350 330 Z"/>
  <path class="fuli-bar fuli-bar--3" fill="${fill}" d="M 410 ${barTop} L 450 ${barTop} L 450 320 L 410 320 Z"/>
</svg>`;
}

function solidPng(size, rgba) {
  const data = new Uint8Array(size * size * 4);
  for (let at = 0; at < size * size; at++) data.set(at % (size + 1) === 0 ? [0, 0, 0, 0] : rgba, at * 4);
  return encodePng({ width: size, height: size, data });
}

// Every brand/ file the generator reads, synthetic, and a reader over them.
function syntheticBrand(overrides = {}) {
  const light = [[0, '#AA7711'], [100, '#111111']];
  const dark = [[0, '#EEBB44'], [100, '#FFFFFF']];
  const files = {
    'brand/svg/mark/fuli-mark-color.svg': syntheticMark({ fill: '#111111', stops: light }),
    'brand/svg/mark/fuli-mark-dark.svg': syntheticMark({ fill: '#FFFFFF', stops: dark }),
    'brand/svg/mark/fuli-mark-micro-color.svg': syntheticMark({ fill: '#111111', stops: light, barTop: 90 }),
    'brand/svg/mark/fuli-mark-micro-dark.svg': syntheticMark({ fill: '#FFFFFF', stops: dark, barTop: 90 }),
    'brand/svg/wordmark/fuli-wordmark-en.svg': '<svg>FULI</svg>',
    'brand/svg/wordmark/fuli-wordmark-zh.svg': '<svg>复利</svg>',
    'brand/motion/fuli-motion.css': '.fuli-brand-svg {}',
    'brand/png/mark/favicon.ico': encodeIco([{ size: 16, bytes: solidPng(16, [17, 17, 17, 255]) }]),
    'brand/png/mark/fuli-mark-color-512.png': solidPng(8, [17, 17, 17, 255]),
    'brand/png/app-icon/fuli-app.ico': encodeIco([16, 32, 256].map((size) => ({ size, bytes: solidPng(size, [250, 250, 250, 255]) }))),
    'brand/png/app-icon/fuli-app-icon-light-512.png': solidPng(512, [240, 240, 240, 255]),
    'brand/png/app-icon/fuli-app-icon-light-1024.png': solidPng(1024, [230, 230, 230, 255]),
    ...overrides
  };
  return (path) => {
    if (!(path in files)) throw new Error(`the generator read an unexpected file ${path}`);
    return Buffer.from(files[path]);
  };
}

test('every checked-in brand copy matches brand/', () => {
  withTempDir((directory) => {
    const assets = brandAssets();
    assert.deepEqual(writeBrandAssets(directory, assets), assets.map(({ path }) => path));
    const stale = assets
      .filter(({ path, same }) => !same(readFileSync(join(PROJECT_ROOT, path)), readFileSync(join(directory, path))))
      .map(({ path }) => path);
    assert.deepEqual(stale, [], 'brand/ changed: run `node scripts/build-brand-assets.js`');
  });
});

test('every brand SVG escapes its ampersands, so browsers can load it as an image', () => {
  const svgs = readdirSync(join(PROJECT_ROOT, 'brand/svg'), { recursive: true })
    .filter((path) => path.endsWith('.svg'))
    .map((path) => join('brand/svg', path));
  assert.ok(svgs.length > 0);
  const bare = svgs.filter((path) => /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(brandFile(path).toString('utf8')));
  assert.deepEqual(bare, []);
});

test('no generated copy carries the retired raster logo', () => {
  assert.deepEqual(brandAssets().filter(({ path }) => path.includes('fuli-logo')), []);
});

test('the mark contract holds both cuts, the golds and the colours of the SVG sources', () => {
  const assets = brandAssets();
  const [contract, drawing] = ['desktop/flutter/assets/brand/fuli-mark.json', 'web/assets/brand/fuli-mark.json']
    .map((path) => JSON.parse(assets.find((asset) => asset.path === path).bytes.toString('utf8')));
  // The desktop client reads exactly these keys; the console adds what it needs to draw the gradient.
  assert.deepEqual(Object.keys(contract), ['master', 'micro', 'gold', 'ink', 'white']);
  assert.deepEqual(drawing, { ...contract, viewBox: [0, 0, 512, 512], goldLine: { x1: 40, y1: 298, x2: 242, y2: 474 }, microBelowPx: 28 });
  const sources = {
    master: readMarkSvg(brandFile('brand/svg/mark/fuli-mark-color.svg').toString('utf8')),
    micro: readMarkSvg(brandFile('brand/svg/mark/fuli-mark-micro-color.svg').toString('utf8'))
  };
  for (const [cut, { layers }] of Object.entries(sources)) {
    assert.deepEqual(contract[cut], {
      orbitGold: layers.orbitGold.d,
      orbitUpper: layers.orbitUpper.d,
      wave: layers.wave.d,
      bars: [layers.bar1.d, layers.bar2.d, layers.bar3.d]
    }, cut);
  }
  assert.deepEqual([contract.ink, contract.white], ['#18181B', '#FFFFFF']);
  assert.deepEqual(contract.gold.light, [[0, '#DC9A30'], [0.34, '#B87B20'], [0.66, '#5C4018'], [0.88, '#241F1A'], [1, '#18181B']]);
  assert.deepEqual(contract.gold.dark, [[0, '#EBA83A'], [0.36, '#F3C668'], [0.7, '#F8E6BE'], [0.96, '#FFFFFF'], [1, '#FFFFFF']]);
});

test('a mark whose light and dark files disagree is refused', () => {
  const dark = syntheticMark({ fill: '#FFFFFF', stops: [[0, '#EEBB44'], [100, '#FFFFFF']], barTop: 100 });
  assert.throws(() => brandAssets(syntheticBrand({ 'brand/svg/mark/fuli-mark-dark.svg': dark })), /bar3 differs/);
});

test('tray icons draw the micro mark below 28 px and the master from 28 px, with three status dots', () => {
  const read = syntheticBrand();
  const assets = brandAssets(read);
  const micro = readMarkSvg(read('brand/svg/mark/fuli-mark-micro-color.svg').toString('utf8'));
  const master = readMarkSvg(read('brand/svg/mark/fuli-mark-color.svg').toString('utf8'));
  const entries = decodeIco(assets.find(({ path }) => path.endsWith('tray/ok.ico')).bytes);
  const pixels = (size) => Buffer.from(decodePng(entries.find((entry) => entry.size === size).bytes).data);
  const drawn = (mark, size) => Buffer.from(trayIcon(() => mark, size, 0x1f9a76).data);
  // 16 px holds a 12 px mark, 40 px a 30 px one.
  assert.ok(pixels(16).equals(drawn(micro, 16)) && !pixels(16).equals(drawn(master, 16)));
  assert.ok(pixels(40).equals(drawn(master, 40)) && !pixels(40).equals(drawn(micro, 40)));
  const trays = ['ok', 'needs_person', 'broken'].map((status) => assets.find(({ path }) => path.endsWith(`tray/${status}.png`)).bytes);
  assert.equal(new Set(trays.map((bytes) => bytes.toString('base64'))).size, 3);
});

test('the generator gives byte-identical files for the same brand', () => {
  const first = brandAssets(syntheticBrand());
  const second = brandAssets(syntheticBrand());
  assert.ok(first.length > 0);
  first.forEach(({ path, bytes }, index) => {
    assert.equal(second[index].path, path);
    assert.ok(bytes.equals(second[index].bytes), path);
  });
});

test('regenerating rewrites only the copies that no longer match', () => {
  withTempDir((directory) => {
    const assets = brandAssets(syntheticBrand());
    writeBrandAssets(directory, assets);
    assert.deepEqual(writeBrandAssets(directory, assets), []);

    const copy = assets[0];
    const icon = assets.find(({ path }) => path.endsWith('.ico') && path.includes('tray/'));
    writeFileSync(join(directory, copy.path), Buffer.from('an older mark'));
    writeFileSync(join(directory, icon.path), Buffer.from('an older icon'));
    assert.deepEqual(writeBrandAssets(directory, assets), [copy.path, icon.path]);
    assert.ok(readFileSync(join(directory, copy.path)).equals(copy.bytes));
    assert.ok(readFileSync(join(directory, icon.path)).equals(icon.bytes));
  });
});
