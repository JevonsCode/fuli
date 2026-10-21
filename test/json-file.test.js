import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonFile, writeJsonFileAtomic } from '../src/storage/json-file.js';
import { assertFileMode } from '../test-support/platform-capabilities.js';

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

test('atomic JSON rewrite passes the existing file mode to the replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  let requestedMode = null;

  try {
    writeFileSync(filePath, '{"version":1}\n');
    chmodSync(filePath, 0o640);
    // NTFS reports only the read-only attribute, so Windows sees 0o666 here.
    const existingMode = statSync(filePath).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(existingMode, 0o640);

    writeJsonFileAtomic(filePath, { version: 2 }, {
      writeFileSync(tempPath, contents, options) {
        requestedMode = options.mode;
        writeFileSync(tempPath, contents, options);
      }
    });

    assert.equal(requestedMode, existingMode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write creates private directories and files by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const directory = join(root, 'private-config');
  const filePath = join(directory, 'context.json');

  try {
    writeJsonFileAtomic(filePath, { version: 1 });

    assertFileMode(directory, 0o700);
    assertFileMode(filePath, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
        },
        pauseSync() {
          assert.fail('a rename failure other than the target being in use is not retried');
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

test('atomic JSON write waits for a reader that holds the target open', {
  skip: process.platform !== 'win32' && 'only Windows refuses to rename over an open file'
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  writeFileSync(filePath, '{"version":1}\n');
  let reader = openSync(filePath, 'r');
  const pauses = [];

  try {
    writeJsonFileAtomic(filePath, { version: 2 }, {
      pauseSync(ms) {
        pauses.push(ms);
        closeSync(reader);
        reader = null;
      }
    });

    assert.equal(pauses.length, 1, 'the open reader refused the first rename');
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 2 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    if (reader !== null) closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write retries a rename refused while the target is in use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  writeFileSync(filePath, '{"version":1}\n');
  const refusals = ['EPERM', 'EACCES', 'EBUSY'];
  const pauses = [];

  try {
    writeJsonFileAtomic(filePath, { version: 2 }, {
      renameSync(from, to) {
        const code = refusals.shift();
        if (code) throw Object.assign(new Error(`${code}: rename`), { code });
        renameSync(from, to);
      },
      pauseSync: (ms) => pauses.push(ms)
    });

    assert.equal(pauses.length, 3);
    assert.ok(pauses.every((ms, index) => index === 0 || ms > pauses[index - 1]), 'each pause is longer');
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 2 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write surfaces a rename that stays refused after bounded retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-json-file-'));
  const filePath = join(dir, 'context.json');
  writeFileSync(filePath, '{"version":1}\n');
  const pauses = [];
  let attempts = 0;

  try {
    assert.throws(
      () => writeJsonFileAtomic(filePath, { version: 2 }, {
        renameSync() {
          attempts += 1;
          throw Object.assign(new Error('EBUSY: rename'), { code: 'EBUSY' });
        },
        pauseSync: (ms) => pauses.push(ms)
      }),
      { code: 'EBUSY' }
    );

    const waited = pauses.reduce((sum, ms) => sum + ms, 0);
    assert.equal(attempts, pauses.length + 1);
    assert.ok(waited >= 2000 && waited < 2500, `waited ${waited} ms in all`);
    assert.ok(Math.max(...pauses) <= 200, 'no single pause is long');
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 1 });
    assert.deepEqual(temporaryFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}
