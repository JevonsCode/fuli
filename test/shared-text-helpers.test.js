import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeTextFileAtomic } from '../src/storage/json-file.js';
import { singleLine } from '../src/text/single-line.js';
import { assertJsonObject } from '../src/validation/values.js';

test('atomic text write replaces the file without leaving a temporary sibling', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-text-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'nested', 'config.toml');
  writeTextFileAtomic(target, 'first = 1\n');
  writeTextFileAtomic(target, 'second = 2\n');
  assert.equal(readFileSync(target, 'utf8'), 'second = 2\n');
  assert.deepEqual(readdirSync(join(directory, 'nested')), ['config.toml']);
});

test('singleLine collapses breaks and tabs and treats missing as empty', () => {
  assert.equal(singleLine(' a\r\n\tb \n'), 'a b');
  assert.equal(singleLine(undefined), '');
});

test('assertJsonObject rejects arrays and scalars', () => {
  assert.doesNotThrow(() => assertJsonObject({}, 'settings'));
  for (const bad of [null, [], 'x']) {
    assert.throws(() => assertJsonObject(bad, 'settings'), /settings must be a JSON object/);
  }
});
