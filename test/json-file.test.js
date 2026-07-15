import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonFile, writeJsonFileAtomic } from '../src/storage/json-file.js';

test('JSON file reads parsed content and falls back for absent or blank files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');

  try {
    assert.deepEqual(readJsonFile(filePath, { empty: true }), { empty: true });
    writeFileSync(filePath, '  \n');
    assert.deepEqual(readJsonFile(filePath, { empty: true }), { empty: true });
    writeFileSync(filePath, '{"version":1}\n');
    assert.deepEqual(readJsonFile(filePath, { empty: true }), { version: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write replaces the target without leaving a temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');

  try {
    writeFileSync(filePath, '{"version":1}\n');

    writeJsonFileAtomic(filePath, { version: 2 });

    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 2 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write cleans up when writing the temporary file fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  writeFileSync(filePath, '{"version":1}\n');

  try {
    assert.throws(
      () => writeJsonFileAtomic(filePath, { version: 2 }, {
        writeFileSync(tempPath, contents, options) {
          writeFileSync(tempPath, contents, options);
          throw new Error('write failed');
        }
      }),
      /write failed/
    );

    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 1 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write cleans up when renaming the temporary file fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  writeFileSync(filePath, '{"version":1}\n');

  try {
    assert.throws(
      () => writeJsonFileAtomic(filePath, { version: 2 }, {
        renameSync() {
          throw new Error('rename failed');
        }
      }),
      /rename failed/
    );

    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 1 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}
