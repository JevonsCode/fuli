import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ASCII, CLIENT_FONTS, CLIENT_STRINGS, clientCharacters, FONTS_DIR } from '../scripts/build-client-fonts.js';
import { fontCharacters } from '../scripts/fonts/font-cmap.js';

const LICENCE_FILES = ['OFL-Inter.txt', 'OFL-NotoSansSC.txt'];
const projectFile = (path) => readFileSync(join(import.meta.dirname, '..', path));
const missing = (font, codePoints) =>
  String.fromCodePoint(...[...codePoints].filter((code) => !fontCharacters(projectFile(`${FONTS_DIR}/${font.file}`)).has(code)));

test('every Noto Sans SC weight draws every character of the client strings', () => {
  const client = clientCharacters(projectFile(CLIENT_STRINGS).toString('utf8'));
  assert.ok([...client].some((code) => code >= 0x4e00 && code <= 0x9fff), 'the strings hold Chinese');
  for (const font of CLIENT_FONTS.filter(({ family }) => family === 'Noto Sans SC')) {
    assert.equal(missing(font, client), '', `strings.dart gained characters ${font.file} lacks: run scripts/build-client-fonts.js`);
  }
});

test('every Inter weight draws printable ASCII', () => {
  for (const font of CLIENT_FONTS.filter(({ family }) => family === 'Inter')) assert.equal(missing(font, ASCII), '', font.file);
});

test('the fonts folder holds the bundled faces at 400, 500 and 600 and their OFL licences only', () => {
  assert.deepEqual(readdirSync(join(import.meta.dirname, '..', FONTS_DIR)).sort(), [...CLIENT_FONTS.map(({ file }) => file), ...LICENCE_FILES].sort());
  assert.deepEqual([...new Set(CLIENT_FONTS.map(({ weight }) => weight))], [400, 500, 600]);
  for (const licence of LICENCE_FILES) {
    assert.match(projectFile(`${FONTS_DIR}/${licence}`).toString('utf8'), /SIL Open Font License, Version 1\.1/);
  }
});

test('the client registers each bundled face in pubspec.yaml at its weight and ships the licences', () => {
  const pubspec = projectFile('desktop/flutter/pubspec.yaml').toString('utf8');
  for (const licence of LICENCE_FILES) assert.match(pubspec, new RegExp(`- assets/fonts/${licence}\n`));
  for (const { family, file, weight } of CLIENT_FONTS) {
    const registered = new RegExp(`- family: ${family}\\n(?:\\s+(?!- family).*\\n)*?\\s+- asset: assets/fonts/${file}\\n\\s+weight: ${weight}\\n`);
    assert.match(pubspec, registered, file);
  }
});

test('the client characters are every character of the strings file but line breaks', () => {
  assert.deepEqual(clientCharacters("t('复利…',\n'复')"), new Set([..."t('复利…',)"].map((character) => character.codePointAt(0))));
});
