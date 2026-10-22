#!/usr/bin/env node
// Builds and freezes the Tonborg review sets (rec#26) before any model run:
// blind inputs in cases/, CL's labels in labels/, and manifest.json with the
// sha256 of every file. It refuses sets that repeat or overlap (see
// case-sets.js) and, with --previous, sets that copy an earlier set's texts.
//
//   node acceptance/tonborg-review-eval/build-sets.js --source <labels/case-source.json> --out <dir> \
//     [--previous <old cases.json> ...]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from '../../src/system/main-module.js';
import { SETS, buildSets } from './case-sets.js';

// Every string of an earlier evaluation file, wherever it sits in the JSON.
export function textsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  return value && typeof value === 'object' ? Object.values(value).flatMap(textsOf) : [];
}

export function labelSheet(cases) {
  return ['blind_id,label,note', ...cases.map(item => `${item.blindId},,`)].join('\n') + '\n';
}

function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, previous: { type: 'string', multiple: true } } });
  if (!values.source || !values.out) throw new TypeError('--source and --out are required');
  const source = JSON.parse(readFileSync(values.source, 'utf8'));
  const previousTexts = (values.previous ?? []).flatMap(path => textsOf(JSON.parse(readFileSync(path, 'utf8'))));
  const built = buildSets(source, { previousTexts });
  const written = [values.source];
  const write = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    written.push(path);
  };
  for (const set of SETS) {
    write(join(values.out, 'cases', `${set}.json`), json(built.cases[set]));
    write(join(values.out, 'cases', `label-sheet-${set}.csv`), labelSheet(built.cases[set]));
  }
  write(join(values.out, 'labels', 'cl-labels.json'), json({ labeler: 'CL',
    method: 'per case, written with the case before any model run; prompt_injection labels are escalate by rule',
    cases: built.labels }));
  const manifest = { frozenAt: new Date().toISOString(), shuffleSeed: source.shuffleSeed,
    counts: Object.fromEntries(SETS.map(set => [set, built.cases[set].length])), checks: built.checks,
    sha256: Object.fromEntries(written.map(path => [relative(values.out, path).split('\\').join('/'),
      createHash('sha256').update(readFileSync(path)).digest('hex')])) };
  writeFileSync(join(values.out, 'manifest.json'), json(manifest));
  console.log(JSON.stringify({ counts: manifest.counts, checks: manifest.checks }, null, 2));
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;

if (isMainModule(import.meta.url)) main();
