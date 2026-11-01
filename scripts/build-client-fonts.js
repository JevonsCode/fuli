#!/usr/bin/env node
// Regenerates the desktop client's bundled fonts (desktop/flutter/assets/fonts/)
// from pinned OFL releases: Inter 4.1 for Latin and Noto Sans SC for Chinese, at
// the design tokens' weights 400, 500 and 600. Noto Sans SC keeps only what the
// client can show: every character of lib/src/l10n/strings.dart, plus ASCII,
// CJK punctuation and full-width forms. Inter keeps the Latin set.
//
//   1. Into a new, empty folder <sources>:
//      - unzip https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip into <sources>/inter;
//      - download NotoSansSC[wght].ttf and OFL.txt from
//        https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc into <sources>/notosanssc.
//   2. Install fonttools at FONTTOOLS_VERSION in a Python of its own (`pip install fonttools==4.60.1`).
//   3. node scripts/build-client-fonts.js --sources <sources> --python <that python>
//
// Every source must match its SHA-256 below. test/client-fonts.test.js fails when
// strings.dart gains a character the Noto Sans SC subset lacks: rerun this then.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sha256Bytes } from '../src/security/digest.js';
import { isMainModule } from '../src/system/main-module.js';
import { fontCharacters } from './fonts/font-cmap.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT_STRINGS = 'desktop/flutter/lib/src/l10n/strings.dart';
export const FONTS_DIR = 'desktop/flutter/assets/fonts';
const FONTTOOLS_VERSION = '4.60.1';
// Subset and instance output carries this date, not the build's, so a rerun gives the same bytes.
const SOURCE_DATE_EPOCH = '1735689600';

const NOTO_SOURCE = 'notosanssc/NotoSansSC[wght].ttf';
const SOURCES = {
  'inter/extras/ttf/Inter-Regular.ttf': '40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82',
  'inter/extras/ttf/Inter-Medium.ttf': '97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872',
  'inter/extras/ttf/Inter-SemiBold.ttf': '78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3',
  'inter/LICENSE.txt': '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',
  [NOTO_SOURCE]: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
  'notosanssc/OFL.txt': '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9'
};
const LICENCES = { 'inter/LICENSE.txt': 'OFL-Inter.txt', 'notosanssc/OFL.txt': 'OFL-NotoSansSC.txt' };

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
// Printable ASCII, so digits and Latin punctuation in a Chinese sentence match it.
export const ASCII = range(0x20, 0x7e);
// Dashes, quotes, ellipsis and per-mille; CJK symbols and punctuation; full-width forms.
const CJK_EXTRA = [...range(0x2010, 0x2027), ...range(0x2030, 0x203a), ...range(0x3000, 0x303f), ...range(0xff01, 0xff5e)];
// Google Fonts' "latin" unicode-range.
const LATIN = [
  ...range(0x0000, 0x00ff), 0x0131, 0x0152, 0x0153, 0x02bb, 0x02bc, 0x02c6, 0x02da, 0x02dc, 0x0304, 0x0308, 0x0329,
  ...range(0x2000, 0x206f), 0x20ac, 0x2122, 0x2191, 0x2193, 0x2212, 0x2215, 0xfeff, 0xfffd
];

// The bundled faces: [file] in FONTS_DIR, subset from Inter's [source], or instanced
// at [weight] from the Noto Sans SC subset.
export const CLIENT_FONTS = [
  ...[[400, 'Regular'], [500, 'Medium'], [600, 'SemiBold']].flatMap(([weight, style]) => [
    { family: 'Inter', weight, file: `Inter-${style}.ttf`, source: `inter/extras/ttf/Inter-${style}.ttf` },
    { family: 'Noto Sans SC', weight, file: `NotoSansSC-${style}.ttf` }
  ])
];

/** The code points the client's text can need: every character of strings.dart. */
export function clientCharacters(strings) {
  return new Set([...strings].map((character) => character.codePointAt(0)).filter((code) => code >= 0x20));
}

function python(executable, args) {
  const run = spawnSync(executable, ['-I', ...args], {
    encoding: 'utf8',
    env: { ...process.env, SOURCE_DATE_EPOCH }
  });
  if (run.status !== 0) throw new Error(`${args.slice(0, 2).join(' ')} failed: ${run.stderr || run.error?.message}`);
  return run.stdout;
}

const unicodes = (codePoints) => [...codePoints].sort((a, b) => a - b).map((code) => code.toString(16)).join(',');

function subset(executable, from, to, codePoints) {
  python(executable, ['-m', 'fontTools.subset', from, `--output-file=${to}`, `--unicodes=${unicodes(codePoints)}`,
    '--name-IDs=0,1,2,3,4,5,6,13,14,16,17', '--no-hinting']);
}

function verifySources(sources) {
  for (const [path, digest] of Object.entries(SOURCES)) {
    const actual = sha256Bytes(readFileSync(join(sources, path)));
    if (actual !== digest) throw new Error(`${path} is not the pinned source (SHA-256 ${actual})`);
  }
}

function buildClientFonts({ sources, executable }) {
  const version = python(executable, ['-c', 'import fontTools; print(fontTools.version)']).trim();
  if (version !== FONTTOOLS_VERSION) throw new Error(`fonttools ${FONTTOOLS_VERSION} is pinned; this Python has ${version}`);
  verifySources(sources);
  const client = clientCharacters(readFileSync(join(PROJECT_ROOT, CLIENT_STRINGS), 'utf8'));
  const chinese = new Set([...client, ...ASCII, ...CJK_EXTRA]);
  const latin = new Set([...LATIN, ...ASCII]);
  const work = mkdtempSync(join(tmpdir(), 'fuli-client-fonts-'));
  try {
    const variableSubset = join(work, 'NotoSansSC-subset.ttf');
    subset(executable, join(sources, NOTO_SOURCE), variableSubset, chinese);
    for (const font of CLIENT_FONTS) {
      const target = join(PROJECT_ROOT, FONTS_DIR, font.file);
      if (font.source) subset(executable, join(sources, font.source), target, latin);
      else python(executable, ['-m', 'fontTools.varLib.instancer', variableSubset, `wght=${font.weight}`, '--update-name-table', '-o', target]);
      const drawn = fontCharacters(readFileSync(target));
      const needed = font.source ? ASCII : client;
      const missing = [...needed].filter((code) => !drawn.has(code));
      if (missing.length) throw new Error(`${font.file} lacks ${String.fromCodePoint(...missing)}`);
    }
    for (const [source, file] of Object.entries(LICENCES)) copyFileSync(join(sources, source), join(PROJECT_ROOT, FONTS_DIR, file));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return CLIENT_FONTS.map(({ file }) => file);
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { sources: { type: 'string' }, python: { type: 'string' } } });
  if (!values.sources || !values.python) {
    console.error('usage: node scripts/build-client-fonts.js --sources <folder> --python <python with fonttools>');
    process.exit(2);
  }
  for (const file of buildClientFonts({ sources: values.sources, executable: values.python })) {
    console.log(`wrote ${FONTS_DIR}/${file}`);
  }
}
