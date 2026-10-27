import assert from 'node:assert/strict';
import { parse, resolve } from 'node:path';
import test from 'node:test';
import { assertShortBuildPath } from '../scripts/windows-build-path.js';

const ROOT = parse(resolve('.')).root;
const syntheticPath = length => {
  const path = ROOT + 'a'.repeat(length - ROOT.length);
  assert.equal(resolve(path).length, length);
  return path;
};

test('the build path guard allows exactly the 80-character root', () => {
  assert.equal(assertShortBuildPath('--output', syntheticPath(80), 'T:\\fb\\portable'), syntheticPath(80));
});

test('the guard refuses a longer root with its option, lengths and a short example', () => {
  assert.throws(() => assertShortBuildPath('--output', syntheticPath(81), 'T:\\fb\\portable'), error => {
    assert.match(error.message, /--output path is too long for Windows/);
    assert.match(error.message, /81 characters/);
    assert.match(error.message, /limit is 80 characters/);
    assert.match(error.message, /T:\\fb\\portable/);
    return true;
  });
});

test('each build names its own option and short example', () => {
  const long = syntheticPath(200);
  assert.throws(() => assertShortBuildPath('--cache-dir', long, 'T:\\fb\\portable'),
    /--cache-dir path is too long for Windows: 200 characters; the limit is 80 characters\..*T:\\fb\\portable/);
  assert.throws(() => assertShortBuildPath('--output', long, 'T:\\fb\\tray'),
    /--output path is too long for Windows: 200 characters; the limit is 80 characters\..*T:\\fb\\tray/);
});
