import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dataFormatMarks, dataNewerThanThisPackage, dataUpgradedSince } from '../src/data-format/data-newer-than-package.js';

// Synthetic data directories only: what a previous version reads, without
// starting anything, before an app update swaps back to it.

function dataDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-newer-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A folder of JSON records (local-stores.js): its state is its worst record's.
const recordDirectory = 'preference-delivery';

// A JSON store's interrupted change: the intent file json-format.js leaves,
// matching neither the content before nor after it.
function halfApplied(path) {
  writeFileSync(`${path}.format-intent.json`, JSON.stringify({ version: 1, beforeDigest: 'a'.repeat(64),
    afterDigest: 'b'.repeat(64), event: { migrationId: 'runtime-settings/2' } }));
}

test('a store a newer version left half upgraded keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 1 }));
  const marks = dataFormatMarks(dataDir);
  halfApplied(join(dataDir, 'runtime-settings.json'));
  assert.equal(dataNewerThanThisPackage(dataDir), 'stores it cannot use: runtime-settings.json half_applied');
  assert.equal(dataUpgradedSince(marks, dataDir), 'stores the new version changed: runtime-settings.json half_applied');
});

test('a data directory this version can run on names no reason', t => {
  assert.equal(dataNewerThanThisPackage(dataDirectory(t)), null);
});

test('a store a newer version upgraded keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 999 }));
  assert.equal(dataNewerThanThisPackage(dataDir), 'stores it cannot use: runtime-settings.json newer_format');
});

test('a store that cannot be read keeps this version off the data, even when it hides a newer record', t => {
  const dataDir = dataDirectory(t);
  // A folder of records that cannot be listed reports unavailable, the worst state, whatever its records hold.
  writeFileSync(join(dataDir, recordDirectory), 'not a folder');
  assert.equal(dataNewerThanThisPackage(dataDir), `stores it cannot use: ${recordDirectory} unavailable`);
});

test('one newer record in a folder of records keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  mkdirSync(join(dataDir, recordDirectory));
  writeFileSync(join(dataDir, recordDirectory, 'a.json'), JSON.stringify({ version: 999 }));
  writeFileSync(join(dataDir, recordDirectory, 'b.json'), JSON.stringify({}));
  assert.equal(dataNewerThanThisPackage(dataDir), `stores it cannot use: ${recordDirectory} newer_format`);
});

test('a native Provider newer than this package keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  mkdirSync(join(dataDir, 'native-runtime'));
  writeFileSync(join(dataDir, 'native-runtime', 'manifest.json'), JSON.stringify({ providerVersion: '999.0.0+native.2' }));
  assert.match(dataNewerThanThisPackage(dataDir), /^provider_downgrade_refused installed=999\.0\.0\+native\.2 required=/);
});

test('a store the newer version moved past what the stopped one left is named; one it created is not', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 1 }));
  const marks = dataFormatMarks(dataDir);
  writeFileSync(join(dataDir, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1 }));
  assert.equal(dataUpgradedSince(marks, dataDir), null);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 2 }));
  assert.equal(dataUpgradedSince(marks, dataDir), 'stores the new version changed: runtime-settings.json 1 → 2');
});

test('records the newer version rewrote in a folder of records are seen, though the folder has no version', t => {
  const dataDir = dataDirectory(t);
  mkdirSync(join(dataDir, recordDirectory));
  for (const name of ['a.json', 'b.json']) writeFileSync(join(dataDir, recordDirectory, name), JSON.stringify({}));
  const marks = dataFormatMarks(dataDir);
  writeFileSync(join(dataDir, recordDirectory, 'c.json'), JSON.stringify({ version: 1 }));
  assert.equal(dataUpgradedSince(marks, dataDir), null, 'a new record alone moves nothing');
  writeFileSync(join(dataDir, recordDirectory, 'a.json'), JSON.stringify({ version: 1 }));
  assert.equal(dataUpgradedSince(marks, dataDir), `stores the new version changed: ${recordDirectory} 1 records rewritten`);
});

test('a store that became unreadable after the newer version ran is named', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 1 }));
  const marks = dataFormatMarks(dataDir);
  writeFileSync(join(dataDir, 'runtime-settings.json'), '{ half written');
  assert.equal(dataUpgradedSince(marks, dataDir), 'stores the new version changed: runtime-settings.json unreadable');
});
